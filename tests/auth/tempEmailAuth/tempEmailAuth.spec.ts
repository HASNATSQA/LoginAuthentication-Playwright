import { test, expect, Page } from '@playwright/test';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

/* -------------------- Config -------------------- */
const SAFE_TIMEOUT_MS = 90_000; // max wait for OTPs
const EMAIL_POLL_INTERVAL_MS = 2000;

/* -------------------- Mail.tm client -------------------- */
class MailTmClient {
  private token = '';
  private accountId = '';
  private baseUrl = 'https://api.mail.tm';

  async login(email: string, password: string) {
    try {
      const res = await axios.post(`${this.baseUrl}/token`, { address: email, password });
      this.token = res.data.token;
      this.accountId = res.data.id;
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error(
          `Mail.tm authentication failed (401 Unauthorized). Please check your MAILTM_EMAIL and MAILTM_PASSWORD in .env file. ` +
          `Email used: ${email ? email.substring(0, 10) + '...' : 'undefined'}. ` +
          `Make sure the Mail.tm account exists and credentials are correct.`
        );
      }
      throw error;
    }
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

/* -------------------- Email wait & extraction -------------------- */
async function waitForNewEmail(mailClient: MailTmClient, previousEmailId?: string) {
  console.log('⏳ Waiting for new 2FA email...');
  
  // Exactly like working script: try 10 times with 3 second intervals (30 seconds total)
  for (let i = 0; i < 10; i++) {
    const inbox = await mailClient.getMessages();
    const latest = inbox[0];
    
    if (latest && latest.id !== previousEmailId) {
      console.log(' New 2FA email received!');
      return latest;
    }
    
    await new Promise(res => setTimeout(res, 3000));
  }
  
  throw new Error('No new 2FA email arrived within 30 seconds.');
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

/* -------------------- Authentication Method Helper -------------------- */
async function ensureEmailSelected(page: Page) {
  console.log('🔍 Checking if Email is already selected...');
  
  // Wait for 2FA dropdown/page to load
  await page.waitForTimeout(1200);
  
  // Check if OTP input field is already visible (meaning OTP was already sent)
  const otpInputVisible = await page.locator('#auth-password').isVisible().catch(() => false);
  if (otpInputVisible) {
    console.log('✅ OTP input already visible - Email was already selected and OTP sent');
    return true;
  }
  
  // Try to check current selection by looking at the combobox value
  let isEmailSelected = false;
  try {
    // Try to get the current selected value
    const combobox = page.getByRole('combobox', { name: /Authentication Method/i });
    const selectedText = await combobox.textContent().catch(() => null);
    
    if (selectedText && selectedText.includes('Email')) {
      isEmailSelected = true;
      console.log('✅ Email is already selected in dropdown');
    } else if (selectedText && (selectedText.includes('SMS') || selectedText.includes('Phone'))) {
      console.log('⚠️ SMS is currently selected, switching to Email...');
      isEmailSelected = false;
    }
  } catch (e) {
    // If we can't determine, assume we need to select Email
    console.log('⚠️ Could not determine current selection, will ensure Email is selected...');
    isEmailSelected = false;
  }
  
  // If Email is not selected, switch to Email
  if (!isEmailSelected) {
    console.log('🔄 Switching to Email option...');
    
    try {
      // Open dropdown using codegen selector - try different names
      console.log('   → Opening dropdown...');
      try {
        await page.getByRole('combobox', { name: /Authentication Method/i }).locator('svg').click();
      } catch {
        // Try with exact name if regex doesn't work
        await page.getByRole('combobox', { name: 'Authentication Method SMS' }).locator('svg').click();
      }
      console.log('   ✅ Dropdown opened');
      await page.waitForTimeout(500);
      
      // Select Email option using codegen selector
      console.log('   → Selecting Email option...');
      await page.getByRole('option', { name: 'Email' }).click();
      console.log('   ✅ Selected Email option');
      await page.waitForTimeout(500);
    } catch (e) {
      console.warn('   ⚠️ Codegen selector failed, trying fallback...');
      // Fallback to old selectors
      const dropdownOpened = await tryClickAny(page, [
        'mat-select',
        'select',
        '[role="combobox"]',
        '.mat-mdc-select',
        '.mat-select'
      ]);
      
      if (dropdownOpened) {
        await page.waitForTimeout(500);
      }
      
      const emailOptionClicked = await tryClickAny(page, [
        'mat-option:has-text("Email")',
        '[role="option"]:has-text("Email")',
        'text=Email'
      ]);
      
      if (!emailOptionClicked) {
        throw new Error('Failed to select Email option from dropdown - cannot proceed');
      }
      await page.waitForTimeout(500);
    }
  }
  
  return true;
}

/* -------------------- The Test -------------------- */
test('DoctorNow login: Email 2FA (robust)', async ({ context }) => {
  test.setTimeout(6 * 60 * 1000); // 6 minutes overall

  const appPage = await context.newPage();

  const DOC_EMAIL = process.env.DOC_EMAIL;
  const DOC_PASSWORD = process.env.DOC_PASSWORD;
  const MAILTM_EMAIL = process.env.MAILTM_EMAIL;
  const MAILTM_PASSWORD = process.env.MAILTM_PASSWORD;

  if (!DOC_EMAIL || !DOC_PASSWORD || !MAILTM_EMAIL || !MAILTM_PASSWORD) {
    const missing = [];
    if (!DOC_EMAIL) missing.push('DOC_EMAIL');
    if (!DOC_PASSWORD) missing.push('DOC_PASSWORD');
    if (!MAILTM_EMAIL) missing.push('MAILTM_EMAIL');
    if (!MAILTM_PASSWORD) missing.push('MAILTM_PASSWORD');
    throw new Error(`Missing required environment variables in .env file: ${missing.join(', ')}`);
  }

  const mailClient = new MailTmClient();
  await mailClient.login(MAILTM_EMAIL!, MAILTM_PASSWORD!);

  // -------- EMAIL FLOW --------
  async function loginUsingEmailFlow() {
    console.log('--- EMAIL FLOW START ---');

    await appPage.goto('https://dev-app.doctornow.io/login', { waitUntil: 'domcontentloaded' });

    await appPage.fill('#user-email', DOC_EMAIL!);
    await appPage.fill('#user-password', DOC_PASSWORD!);

    const clicked = await tryClickAny(appPage, ['.mdc-button__label', 'button[type="submit"]', 'button:has-text("Login")']);
    if (!clicked) await appPage.press('#user-password', 'Enter');

    // Always ensure Email is selected
    await ensureEmailSelected(appPage);

    // Get inbox BEFORE clicking login - exactly like working script
    const inboxBefore = await mailClient.getMessages();
    const lastEmailId = inboxBefore[0]?.id;

    // Check if OTP input is already visible (meaning OTP was already sent)
    const otpAlreadySent = await appPage.locator('#auth-password').isVisible().catch(() => false);
    if (!otpAlreadySent) {
      // Click Send button if needed
      await tryClickAny(appPage, ['button:has-text("Send")', 'button:has-text("Send OTP")', 'button:has-text("Continue")', '.mdc-button__label']);
    }

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

    console.log('Waiting 7 seconds for page to fully load after 2FA entry...');
    await delay(7000); // Wait 7 seconds as page takes time to load
    
    // Wait for profile menu to be available
    await appPage.waitForSelector('.mat-mdc-menu-trigger.profile_pic, .mat-mdc-menu-trigger, .mat-mdc-button-touch-target', { timeout: 10000 });
    console.log('✅ Logged in using Email 2FA - Profile menu is now available');
  }

  // -------- Logout helper --------
  async function logoutFromProfile() {
    console.log('Logging out...');
    try {
      // Wait for the page to be ready
      await appPage.waitForTimeout(1000);
      
      // Wait for profile menu button to be available with multiple strategies
      console.log('Looking for profile menu button...');
      
      let menuOpened = false;
      
      // Strategy 1: Try role-based selector with exact name
      try {
        await appPage.waitForTimeout(1000);
        const profileButton = appPage.getByRole('button', { name: 'Welcome Hasnat Ahmad, M.D.' });
        await profileButton.waitFor({ state: 'visible', timeout: 5000 });
        await profileButton.click();
        menuOpened = true;
        console.log('Opened profile menu using role selector (exact name)');
      } catch (e) {
        console.log('Role selector with exact name failed, trying flexible match...');
        
        // Strategy 2: Try role-based selector with partial/flexible name match
        try {
          // First, wait a bit more and check if button exists with getByRole using partial match
          try {
            // Try with just "Welcome" as partial match
            const welcomeButton = appPage.getByRole('button', { name: /Welcome/i });
            await welcomeButton.waitFor({ state: 'visible', timeout: 5000 });
            await welcomeButton.click();
            menuOpened = true;
            console.log('Opened profile menu using role selector (partial match "Welcome")');
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
                  console.log(`Opened profile menu using button with text: "${text.trim()}"`);
                  break;
                }
              } catch (e) {
                // Continue to next button
              }
            }
          }
        } catch (e2) {
          console.log('Flexible role selector failed, trying class selectors...');
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
          console.log('Opened profile menu using class selectors');
        }
      }
      
      if (!menuOpened) {
        throw new Error('Could not find or click profile menu button');
      }
      
      // Wait for menu to appear
      await appPage.waitForTimeout(500);
      
      // Click logout menu item
      console.log(' Looking for logout menu item...');
      let logoutClicked = false;
      
      // Strategy 1: Try role-based selector
      try {
        const logoutItem = appPage.getByRole('menuitem', { name: 'exit_to_app Logout' });
        await logoutItem.waitFor({ state: 'visible', timeout: 3000 });
        await logoutItem.click();
        logoutClicked = true;
        console.log('Clicked logout using role selector');
      } catch (e) {
        console.log('Role selector for logout failed, trying text-based...');
        
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
          console.log('Clicked logout using text-based selector');
        }
      }
      
      if (!logoutClicked) {
        throw new Error('Could not find or click logout menu item');
      }
      
      // Wait for redirect to login page
      await appPage.waitForURL(/login/, { timeout: 15000 });
      console.log('Logged out successfully');
    } catch (err) {
      console.error('Error during logout:', err);
      throw err;
    }
  }

  // -------- Run sequence --------
  try {
    await loginUsingEmailFlow();
    await logoutFromProfile();

    console.log('Email flow completed successfully');
  } catch (err) {
    console.error('Test failed:', err);
    try { await appPage.screenshot({ path: 'failure-app.png' }); } catch {}
    throw err;
  } finally {
    try { await appPage.close(); } catch {}
  }
});