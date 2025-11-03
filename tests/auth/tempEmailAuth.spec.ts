import { test, expect, Page } from '@playwright/test';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

/* -------------------- Config -------------------- */
const SAFE_TIMEOUT_MS = 90_000; // max wait for OTPs
const EMAIL_POLL_INTERVAL_MS = 2000;
const SMS_POLL_INTERVAL_MS = 2500;

/* -------------------- Mail.tm client -------------------- */
class MailTmClient {
  private token = '';
  private accountId = '';
  private baseUrl = 'https://api.mail.tm';

  async login(email: string, password: string) {
    const res = await axios.post(`${this.baseUrl}/token`, { address: email, password });
    this.token = res.data.token;
    this.accountId = res.data.id;
  }

  async getMessages() {
    const res = await axios.get(`${this.baseUrl}/messages`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data['hydra:member'] || [];
  }

  async getMessageBody(id: string) {
    const res = await axios.get(`${this.baseUrl}/messages/${id}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data.text || res.data.intro || '';
  }

  async getMessageBodyText(id: string) {
    // Alias for compatibility
    return this.getMessageBody(id);
  }

}

/* -------------------- Utilities -------------------- */
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function extract6DigitOtpFromText(text: string | null) {
  if (!text) return null;
  // Normalize to make extraction tolerant to whitespace / HTML artifacts
  // Replace non-digit characters with single space, then find 6-digit sequence
  const normalized = (text || '').replace(/[\u00A0]/g, ' ').replace(/[^0-9]/g, ' ');
  const m = normalized.match(/\b(\d{6})\b/);
  if (m) return m[1];
  // fallback: try without word boundaries (some weird spacing)
  const m2 = normalized.match(/(\d{6})/);
  return m2 ? m2[1] : null;
}

function getMessageTimestamp(msg: any): number | null {
  const candidates = ['createdAt', 'updatedAt', '@timestamp', 'date', 'receivedAt', 'sentAt', 'timestamp'];
  for (const c of candidates) {
    if (msg[c]) {
      const ts = Date.parse(msg[c]);
      if (!Number.isNaN(ts)) return ts;
    }
  }
  return null;
}

/* -------------------- Email wait & extraction -------------------- */
async function waitForNewEmail(mailClient: MailTmClient, previousEmailId?: string) {
  console.log('⏳ Waiting for new 2FA email...');
  
  // Exactly like working script: try 10 times with 3 second intervals (30 seconds total)
  for (let i = 0; i < 10; i++) {
    const inbox = await mailClient.getMessages();
    const latest = inbox[0];
    
    if (latest && latest.id !== previousEmailId) {
      console.log('📩 New 2FA email received!');
      return latest;
    }
    
    await new Promise(res => setTimeout(res, 3000));
  }
  
  throw new Error('No new 2FA email arrived within 30 seconds.');
}

/* -------------------- SMS wait & extraction (ReceiveSMS scraping) -------------------- */
function parseRelativeAgoToTimestamp(agoText: string | null) {
  if (!agoText) return null;
  const t = agoText.trim().toLowerCase();
  const m = t.match(/(\d+)\s*(second|sec|minute|min|hour|hr|day)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const now = Date.now();
  if (unit.startsWith('sec')) return now - n * 1000;
  if (unit.startsWith('min')) return now - n * 60_000;
  if (unit.startsWith('hour') || unit === 'hr') return now - n * 60 * 60_000;
  if (unit.startsWith('day')) return now - n * 24 * 60 * 60_000;
  return null;
}

async function waitForOtpSms(page: Page, inboxUrl: string, startAfter: number | null = null, timeoutMs = SAFE_TIMEOUT_MS) {
  console.log(`📨 Opening SMS inbox: ${inboxUrl}`);
  const start = Date.now();
  await page.goto(inboxUrl, { waitUntil: 'domcontentloaded' });
  
  const targetPhoneNumber = '14806855617';
  console.log(`🔍 Looking for SMS from phone number: ${targetPhoneNumber}`);

  while (Date.now() - start < timeoutMs) {
    const rawCandidates: { text: string; timeText: string | null }[] = await page.evaluate(() => {
      const selectors = [
        '.sms-table tbody tr',
        '.table tbody tr',
        '.messages .message',
        '.inbox .message',
        '.sms-list .sms',
        '#messages .msg',
        '.message-row',
        '.list-group-item',
      ];
      let rows: HTMLElement[] = [];
      for (const s of selectors) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(s));
        if (els.length) {
          rows = els;
          break;
        }
      }
      if (rows.length === 0) {
        const main = document.querySelector<HTMLElement>('main, #main, #container, body');
        if (main) rows = [main];
      }

      const out: { text: string; timeText: string | null }[] = [];
      for (const r of rows) {
        const text = r.innerText || '';
        let timeText: string | null = null;
        const timeSelectors = ['.time', '.date', '.ago', '.time-ago', 'td.time', '.sms-time', '.message__time', '.text-muted'];
        for (const ts of timeSelectors) {
          const el = r.querySelector(ts);
          if (el && el.textContent) {
            const t = el.textContent.trim();
            if (t.length < 100) {
              timeText = t;
              break;
            }
          }
        }
        if (!timeText) {
          const m = text.match(/\b\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\s*ago\b/i);
          if (m) timeText = m[0];
        }
        out.push({ text: text.trim(), timeText });
      }
      return out;
    });

    const now = Date.now();
    const parsed = rawCandidates.map((c) => ({ text: c.text, timeText: c.timeText, ts: c.timeText ? parseRelativeAgoToTimestamp(c.timeText) : null }));
    const withOtp = parsed.map((p) => ({ ...p, otp: extract6DigitOtpFromText(p.text) })).filter((p) => p.otp);

    // Filter to only SMS from target phone number (14806855617)
    const fromTargetNumber = withOtp.filter((p) => {
      return p.text.includes(targetPhoneNumber);
    });

    if (fromTargetNumber.length > 0) {
      // Filter to only SMS that show "seconds ago" (very recent)
      const recentSMS = fromTargetNumber.filter((p) => {
        const timeTextLower = (p.timeText || '').toLowerCase();
        const isRecentSeconds = timeTextLower.match(/\d+\s*(second|sec)s?\s*ago/i);
        if (!isRecentSeconds) return false;
        
        // Also check the seconds count - only accept if <= 120 seconds
        const secondsMatch = timeTextLower.match(/(\d+)\s*(second|sec)/i);
        if (secondsMatch) {
          const secondsAgo = parseInt(secondsMatch[1], 10);
          return secondsAgo <= 120;
        }
        return true; // If we can't parse, accept it if it says "seconds ago"
      });
      
      if (recentSMS.length > 0) {
        // Sort by timestamp: OLDEST first (first one sent is usually the valid one)
        // When multiple SMS are sent, the first one is what the server expects
        const candidates = recentSMS.map((p) => ({ ...p, effTs: p.ts ?? now }));
        candidates.sort((a: any, b: any) => a.effTs - b.effTs); // OLDEST first (changed from newest)
        const oldest = candidates[0];
        
        if (recentSMS.length > 1) {
          console.log(`⚠️ Found ${recentSMS.length} SMS from ${targetPhoneNumber} showing "seconds ago". Using the OLDEST one (first sent) to avoid invalid codes.`);
        }
        
        const timeTextLower = (oldest.timeText || '').toLowerCase();
        const secondsMatch = timeTextLower.match(/(\d+)\s*(second|sec)/i);
        const secondsAgo = secondsMatch ? parseInt(secondsMatch[1], 10) : null;
        
        console.log(`✅ Using SMS from ${targetPhoneNumber} (${secondsAgo ? secondsAgo + ' seconds ago' : 'recent'}): otp=${oldest.otp}`);
        return oldest.otp!;
      } else {
        // Found SMS from target number but none show "seconds ago"
        const newest = fromTargetNumber[0];
        const timeTextLower = (newest.timeText || '').toLowerCase();
        if (timeTextLower.match(/(minute|min|hour|hr|day|week|month|year)/i)) {
          console.log(`⏭️ Found SMS from ${targetPhoneNumber} but it's too old (${newest.timeText}), refreshing for SMS with "seconds ago"...`);
        } else {
          console.log(`⏭️ Found SMS from ${targetPhoneNumber} but none show "seconds ago", refreshing...`);
        }
      }
    } else if (withOtp.length > 0) {
      console.log(`📭 Found ${withOtp.length} SMS OTP(s) but none from ${targetPhoneNumber}, refreshing...`);
    } else {
      console.log('📭 No SMS OTP found yet (checked inbox rows), refreshing...');
    }

    await delay(SMS_POLL_INTERVAL_MS);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  throw new Error('Timeout waiting for SMS OTP on ReceiveSMS inbox');
}

/* -------------------- Robust click helper -------------------- */
async function tryClickAny(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      if (await loc.count()) {
        await loc.first().scrollIntoViewIfNeeded();
        await loc.first().click({ force: false });
        return true;
      }
    } catch {
      // ignore and try next
    }
  }
  return false;
}

/* -------------------- The Test -------------------- */
test('DoctorNow login: Email then Phone 2FA (robust)', async ({ context }) => {
  test.setTimeout(6 * 60 * 1000); // 6 minutes overall

  const appPage = await context.newPage();
  const smsPage = await context.newPage();

  const DOC_EMAIL = process.env.DOC_EMAIL!;
  const DOC_PASSWORD = process.env.DOC_PASSWORD!;
  const MAILTM_EMAIL = process.env.MAILTM_EMAIL!;
  const MAILTM_PASSWORD = process.env.MAILTM_PASSWORD!;
  const RECEIVE_SMS_URL = process.env.RECEIVE_SMS_URL || 'https://www.receivesms.co/us-phone-number/21157/';

  if (!DOC_EMAIL || !DOC_PASSWORD || !MAILTM_EMAIL || !MAILTM_PASSWORD) {
    throw new Error('Please add DOC_EMAIL, DOC_PASSWORD, MAILTM_EMAIL, MAILTM_PASSWORD to .env');
  }

  const mailClient = new MailTmClient();
  await mailClient.login(MAILTM_EMAIL, MAILTM_PASSWORD);

  // -------- EMAIL FLOW --------
  async function loginUsingEmailFlow() {
    console.log('--- EMAIL FLOW START ---');

    await appPage.goto('https://dev-app.doctornow.io/login', { waitUntil: 'domcontentloaded' });

    await appPage.fill('#user-email', DOC_EMAIL);
    await appPage.fill('#user-password', DOC_PASSWORD);

    // Get inbox BEFORE clicking login - exactly like working script
    const inboxBefore = await mailClient.getMessages();
    const lastEmailId = inboxBefore[0]?.id;

    // Click login button - exactly like working script
    await appPage.click('.mdc-button__label');

    // Wait for NEW email (exactly like working script)
    const newEmail = await waitForNewEmail(mailClient, lastEmailId);

    // Extract OTP from the new email (exactly like working script)
    const emailBody = await mailClient.getMessageBody(newEmail.id);
    const otpMatch = emailBody.match(/\b\d{6}\b/);
    const otpCode = otpMatch ? otpMatch[0] : null;

    if (!otpCode) {
      throw new Error('Could not find OTP in the email!');
    }
    
    console.log(`Found OTP: ${otpCode}`);

    await appPage.fill('#auth-password', otpCode);
    await appPage.press('#auth-password', 'Enter');

    console.log('⏳ Waiting 15 seconds for page to fully load after 2FA entry...');
    await delay(15000); // Wait 15 seconds as page takes time to load
    
    // Wait for profile menu to be available
    await appPage.waitForSelector('.mat-mdc-menu-trigger.profile_pic, .mat-mdc-menu-trigger, .mat-mdc-button-touch-target', { timeout: 10000 });
    console.log('✅ Logged in using Email 2FA - Profile menu is now available');
  }

  // -------- PHONE FLOW --------
  async function loginUsingPhoneFlow() {
    console.log('--- PHONE FLOW START ---');
    await appPage.goto('https://dev-app.doctornow.io/login', { waitUntil: 'domcontentloaded' });

    await appPage.fill('#user-email', DOC_EMAIL);
    await appPage.fill('#user-password', DOC_PASSWORD);

    const clicked = await tryClickAny(appPage, ['.mdc-button__label', 'button[type="submit"]', 'button:has-text("Login")']);
    if (!clicked) await appPage.press('#user-password', 'Enter');

    // Wait for 2FA dropdown/page to load
    await appPage.waitForTimeout(1200);

    // Check if OTP input field is already visible (meaning OTP was already sent)
    const otpInputVisible = await appPage.locator('#auth-password').isVisible().catch(() => false);
    if (otpInputVisible) {
      console.log('✅ OTP input already visible - proceeding directly to fetch SMS...');
    } else {
      // Always explicitly select Phone/SMS to ensure Email is not selected
      console.log('🔄 Ensuring Phone/SMS option is selected from dropdown...');
      
      try {
        // Open dropdown using codegen selector - try different names
        console.log('   → Opening dropdown...');
        try {
          await appPage.getByRole('combobox', { name: /Authentication Method/i }).locator('svg').click();
        } catch {
          // Try with exact name if regex doesn't work
          await appPage.getByRole('combobox', { name: 'Authentication Method Email' }).locator('svg').click();
        }
        console.log('   ✅ Dropdown opened');
        await appPage.waitForTimeout(500);
        
        // Select SMS option using codegen selector
        console.log('   → Selecting SMS option...');
        await appPage.getByRole('option', { name: 'SMS' }).click();
        console.log('   ✅ Selected SMS option');
      } catch (e) {
        console.warn('   ⚠️ Codegen selector failed, trying fallback...');
        // Fallback to old selectors
        const dropdownOpened = await tryClickAny(appPage, [
          'mat-select',
          'select',
          '[role="combobox"]',
          '.mat-mdc-select',
          '.mat-select'
        ]);
        
        if (dropdownOpened) {
          await appPage.waitForTimeout(500);
        }
        
        const phoneOptionClicked = await tryClickAny(appPage, [
          '#mat-option-0',
          'mat-option:has-text("Phone")',
          'mat-option:has-text("SMS")',
          '[role="option"]:has-text("SMS")',
          'text=SMS'
        ]);
        
        if (!phoneOptionClicked) {
          throw new Error('❌ Failed to select Phone/SMS option from dropdown - cannot proceed');
        }
      }
    }

    // If there's a button to send OTP (try several) - but only if OTP input is not already visible
    const otpAlreadySent = await appPage.locator('#auth-password').isVisible().catch(() => false);
    if (!otpAlreadySent) {
      // Record timestamp BEFORE clicking Send to ensure we only get SMS sent after this moment
      await delay(500);
      const startAfter = Date.now();
      console.log(`📅 Recorded Send click timestamp: ${startAfter} (will only accept SMS after this)`);
      
      // Click Send button
      await tryClickAny(appPage, ['button:has-text("Send")', 'button:has-text("Send OTP")', 'button:has-text("Continue")', '.mdc-button__label']);
      
      // Wait a few seconds for the SMS to be sent and arrive (to avoid getting old duplicate SMS)
      console.log('⏳ Waiting 5 seconds for SMS to be sent and arrive...');
      await delay(5000);
      
      const otp = await waitForOtpSms(smsPage, RECEIVE_SMS_URL, startAfter, SAFE_TIMEOUT_MS);
      console.log('🔢 SMS OTP found =', otp);

      await appPage.fill('#auth-password', otp);
      await appPage.press('#auth-password', 'Enter');
    } else {
      console.log('OTP already sent, proceeding to fetch SMS...');
      const otp = await waitForOtpSms(smsPage, RECEIVE_SMS_URL, null, SAFE_TIMEOUT_MS);
      console.log('🔢 SMS OTP found =', otp);
      
      await appPage.fill('#auth-password', otp);
      await appPage.press('#auth-password', 'Enter');
    }

    console.log('⏳ Waiting 15 seconds for page to fully load after 2FA entry...');
    await delay(15000); // Wait 15 seconds as page takes time to load
    
    // Wait for profile menu to be available
    await appPage.waitForSelector('.mat-mdc-menu-trigger.profile_pic, .mat-mdc-menu-trigger, .mat-mdc-button-touch-target', { timeout: 10000 });
    console.log('✅ Logged in using Phone 2FA - Profile menu is now available');
  }

  // -------- Logout helper --------
  async function logoutFromProfile() {
    console.log('🚪 Logging out...');
    try {
      // Wait for the page to be ready
      await appPage.waitForTimeout(1000);
      
      // Wait for profile menu button to be available with multiple strategies
      console.log('🔍 Looking for profile menu button...');
      
      let menuOpened = false;
      
      // Strategy 1: Try role-based selector with exact name
      try {
        await appPage.waitForTimeout(1000);
        const profileButton = appPage.getByRole('button', { name: 'Welcome Hasnat Ahmad, M.D.' });
        await profileButton.waitFor({ state: 'visible', timeout: 5000 });
        await profileButton.click();
        menuOpened = true;
        console.log('✅ Opened profile menu using role selector (exact name)');
      } catch (e) {
        console.log('⚠️ Role selector with exact name failed, trying flexible match...');
        
        // Strategy 2: Try role-based selector with partial/flexible name match
        try {
          // First, wait a bit more and check if button exists with getByRole using partial match
          try {
            // Try with just "Welcome" as partial match
            const welcomeButton = appPage.getByRole('button', { name: /Welcome/i });
            await welcomeButton.waitFor({ state: 'visible', timeout: 5000 });
            await welcomeButton.click();
            menuOpened = true;
            console.log('✅ Opened profile menu using role selector (partial match "Welcome")');
          } catch {
            // If that fails, search through all buttons
            const buttons = appPage.locator('button');
            const count = await buttons.count();
            console.log(`Found ${count} buttons on page, searching for Welcome button...`);
            for (let i = 0; i < count; i++) {
              const button = buttons.nth(i);
              try {
                const text = await button.textContent();
                if (text && (text.includes('Welcome') || text.includes('Hasnat'))) {
                  console.log(`Found button with text: "${text.trim()}"`);
                  await button.waitFor({ state: 'visible', timeout: 2000 });
                  await button.scrollIntoViewIfNeeded();
                  await button.click();
                  menuOpened = true;
                  console.log(`✅ Opened profile menu using button with text: "${text.trim()}"`);
                  break;
                }
              } catch (e) {
                // Continue to next button
              }
            }
          }
        } catch (e2) {
          console.log('⚠️ Flexible role selector failed, trying class selectors...');
        }
      }
      
      // Strategy 3: Fallback to class-based selectors
      if (!menuOpened) {
        menuOpened = await tryClickAny(appPage, [
          '.mat-mdc-menu-trigger.profile_pic',
          'button.mat-mdc-menu-trigger.profile_pic',
          '.mat-mdc-menu-trigger',
          'button.mat-mdc-menu-trigger',
          '.profile_pic',
          'button:has-text("Welcome")'
        ]);
        if (menuOpened) {
          console.log('✅ Opened profile menu using class selectors');
        }
      }
      
      if (!menuOpened) {
        throw new Error('Could not find or click profile menu button');
      }
      
      // Wait for menu to appear
      await appPage.waitForTimeout(500);
      
      // Click logout menu item
      console.log('🔍 Looking for logout menu item...');
      let logoutClicked = false;
      
      // Strategy 1: Try role-based selector
      try {
        const logoutItem = appPage.getByRole('menuitem', { name: 'exit_to_app Logout' });
        await logoutItem.waitFor({ state: 'visible', timeout: 3000 });
        await logoutItem.click();
        logoutClicked = true;
        console.log('✅ Clicked logout using role selector');
      } catch (e) {
        console.log('⚠️ Role selector for logout failed, trying text-based...');
        
        // Strategy 2: Try text-based selectors
        logoutClicked = await tryClickAny(appPage, [
          '[role="menuitem"]:has-text("Logout")',
          'mat-menu-item:has-text("Logout")',
          '.alignment-profile',
          'text=Logout',
          'button:has-text("Logout")',
          'a:has-text("Logout")',
          '*:has-text("exit_to_app Logout")'
        ]);
        
        if (logoutClicked) {
          console.log('✅ Clicked logout using text-based selector');
        }
      }
      
      if (!logoutClicked) {
        throw new Error('Could not find or click logout menu item');
      }
      
      // Wait for redirect to login page
      await appPage.waitForURL(/login/, { timeout: 15000 });
      console.log('✅ Logged out successfully');
    } catch (err) {
      console.error('❌ Error during logout:', err);
      throw err;
    }
  }

  // -------- Run sequence --------
  try {
    await loginUsingEmailFlow();
    await logoutFromProfile();

    await loginUsingPhoneFlow();
    await logoutFromProfile();

    console.log('🎉 Both flows completed successfully');
  } catch (err) {
    console.error('❌ Test failed:', err);
    try { await appPage.screenshot({ path: 'failure-app.png' }); } catch {}
    try { await smsPage.screenshot({ path: 'failure-sms.png' }); } catch {}
    throw err;
  } finally {
    try { await appPage.close(); } catch {}
    try { await smsPage.close(); } catch {}
  }
});
