import { Page } from '@playwright/test';
import axios from 'axios';

/* -------------------- Mail.tm client -------------------- */
export class MailTmClient {
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
export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function extract6DigitOtpFromText(text: string | null) {
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
export async function waitForNewEmail(mailClient: MailTmClient, previousEmailId?: string) {
  console.log('⏳ Waiting for new 2FA email...');
  
  // Exactly like working script: try 10 times with 3 second intervals (30 seconds total)
  for (let i = 0; i < 10; i++) {
    const inbox = await mailClient.getMessages();
    const latest = inbox[0];
    
    if (latest && latest.id !== previousEmailId) {
      console.log('✅ New 2FA email received!');
      return latest;
    }
    
    await new Promise(res => setTimeout(res, 3000));
  }
  
  throw new Error('No new 2FA email arrived within 30 seconds.');
}

/* -------------------- Robust click helper -------------------- */
export async function tryClickAny(page: Page, selectors: string[]) {
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
export async function ensureEmailSelected(page: Page) {
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

/* -------------------- Main Reusable Function -------------------- */
export interface EmailAuthOptions {
  page: Page;
  mailClient: MailTmClient;
  userEmail: string;
  userPassword: string;
  loginUrl?: string;
  waitAfterLogin?: number;
}

/**
 * Reusable function to perform email 2FA authentication flow.
 * 
 * @param options - Configuration options for the authentication flow
 * @returns Promise that resolves when login is complete
 * 
 * @example
 * ```typescript
 * import { loginWithEmail2FA, MailTmClient } from '../utils/emailAuth';
 * 
 * const mailClient = new MailTmClient();
 * await mailClient.login(MAILTM_EMAIL, MAILTM_PASSWORD);
 * 
 * await loginWithEmail2FA({
 *   page: appPage,
 *   mailClient,
 *   userEmail: DOC_EMAIL,
 *   userPassword: DOC_PASSWORD,
 *   loginUrl: 'https://dev-app.doctornow.io/login'
 * });
 * ```
 */
export async function loginWithEmail2FA(options: EmailAuthOptions): Promise<void> {
  const {
    page,
    mailClient,
    userEmail,
    userPassword,
    loginUrl = 'https://dev-app.doctornow.io/login',
    waitAfterLogin = 7000
  } = options;

  console.log('--- EMAIL FLOW START ---');

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  await page.fill('#user-email', userEmail);
  await page.fill('#user-password', userPassword);

  const clicked = await tryClickAny(page, ['.mdc-button__label', 'button[type="submit"]', 'button:has-text("Login")']);
  if (!clicked) await page.press('#user-password', 'Enter');

  // Always ensure Email is selected
  await ensureEmailSelected(page);

  // Get inbox BEFORE clicking login - exactly like working script
  const inboxBefore = await mailClient.getMessages();
  const lastEmailId = inboxBefore[0]?.id;

  // Check if OTP input is already visible (meaning OTP was already sent)
  const otpAlreadySent = await page.locator('#auth-password').isVisible().catch(() => false);
  if (!otpAlreadySent) {
    // Click Send button if needed
    await tryClickAny(page, ['button:has-text("Send")', 'button:has-text("Send OTP")', 'button:has-text("Continue")', '.mdc-button__label']);
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

  await page.fill('#auth-password', otpCode);
  await page.press('#auth-password', 'Enter');

  console.log(`Waiting ${waitAfterLogin}ms for page to fully load after 2FA entry...`);
  await delay(waitAfterLogin);
  
  // Wait for page to fully load after 2FA
  await page.waitForLoadState('networkidle');
  
  // Wait for profile menu to be available using modern Playwright API
  // Try multiple selectors with fallback strategy
  let profileMenuFound = false;
  const selectors = [
    'span:nth-of-type(5)',
    '.mat-mdc-menu-trigger.profile_pic',
    '.mat-mdc-menu-trigger',
    '.mat-mdc-button-touch-target',
    'button:has-text("Welcome")'
  ];
  
  for (const selector of selectors) {
    try {
      const locator = selector.includes('nth-of-type') 
        ? page.locator('span').nth(5)
        : page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      profileMenuFound = true;
      console.log(`✅ Profile menu found using selector: ${selector}`);
      break;
    } catch {
      // Try next selector
      continue;
    }
  }
  
  if (!profileMenuFound) {
    throw new Error('Profile menu not found after login - authentication may have failed');
  }
  
  console.log('✅ Logged in using Email 2FA - Profile menu is now available');
}
