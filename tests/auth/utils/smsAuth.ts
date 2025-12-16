import { Page } from '@playwright/test';
import axios from 'axios';

/* -------------------- Config -------------------- */
const SAFE_TIMEOUT_MS = 90_000;
const SMS_POLL_INTERVAL_MS = 2500;
const MIN_AGE_MS = 1000;
const MAX_AGE_MS = 30000;

/* -------------------- Message Property Helpers -------------------- */
function getMessageField(msg: any, fields: string[]): string {
  for (const field of fields) {
    if (msg[field]) return String(msg[field]);
  }
  return '';
}

function getMessageText(msg: any): string {
  return getMessageField(msg, ['text', 'body', 'message', 'content']);
}

function getMessageId(msg: any): string {
  return msg.id || msg.messageId || msg._id || JSON.stringify(msg);
}

function getMessageTimestamp(msg: any): number | null {
  if (typeof msg.timestamp === 'number') return msg.timestamp;
  
  const candidates = ['timestamp', 'createdAt', 'updatedAt', '@timestamp', 'date', 'receivedAt', 'sentAt'];
  for (const c of candidates) {
    if (msg[c]) {
      if (typeof msg[c] === 'number') return msg[c];
      const ts = Date.parse(msg[c]);
      if (!Number.isNaN(ts)) return ts;
    }
  }
  return null;
}

function extract6DigitOtpFromText(text: string | null): string | null {
  if (!text) return null;
  // First try to extract from DN verification format: "(123456) is your DN verification code..."
  const dnFormatMatch = text.match(/\((\d{6})\)\s*is\s*your\s*DN\s*verification\s*code/i);
  if (dnFormatMatch) return dnFormatMatch[1];
  
  // Fallback: extract any 6-digit code
  const normalized = text.replace(/[\u00A0]/g, ' ').replace(/[^0-9]/g, ' ');
  return normalized.match(/\b(\d{6})\b/)?.[1] || normalized.match(/(\d{6})/)?.[1] || null;
}

function getOtpFromMessage(msg: any): string | null {
  return msg.code || extract6DigitOtpFromText(getMessageText(msg));
}

/* -------------------- SMS API client (receivesms.co) -------------------- */
export class ReceiveSmsApiClient {
  private apiUrl: string;
  public senderPhoneNumber: string;

  constructor(receiveSmsUrl: string, senderPhoneNumber: string) {
    this.apiUrl = receiveSmsUrl.replace(/\/$/, '');
    this.senderPhoneNumber = senderPhoneNumber;
  }

  private parseMessagesFromHtml(html: string): any[] {
    const messages: any[] = [];
    const articleRegex = /<article[^>]*class="[^"]*entry-card[^"]*"[^>]*>(.*?)<\/article>/gs;
    let articleMatch;
    
    while ((articleMatch = articleRegex.exec(html)) !== null) {
      const articleHtml = articleMatch[1];
      const fromMatch = articleHtml.match(/<a[^>]*href="[^"]*who-called-me\/(\d+)[^"]*"[^>]*class="[^"]*from-link[^"]*"[^>]*>(\d+)<\/a>/);
      const fromNumber = fromMatch ? (fromMatch[2] || fromMatch[1]) : '';
      
      const codeMatch = articleHtml.match(/<strong[^>]*class="[^"]*code[^"]*"[^>]*data-code="(\d+)"[^>]*>(\d+)<\/strong>/) ||
                       articleHtml.match(/<span[^>]*class="[^"]*chip[^"]*"[^>]*data-code="(\d+)"[^>]*>/);
      const code = codeMatch ? (codeMatch[2] || codeMatch[1]) : '';
      
      const smsMatch = articleHtml.match(/<div[^>]*class="[^"]*sms[^"]*"[^>]*>(.*?)<\/div>/s);
      const messageText = smsMatch ? smsMatch[1].replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
      
      const timeMatch = articleHtml.match(/<span[^>]*class="[^"]*muted[^"]*"[^>]*>([^<]+)<\/span>/);
      const timeText = timeMatch ? timeMatch[1].trim() : '';
      const timestamp = this.parseRelativeTime(timeText);
      
      if (fromNumber || messageText) {
        messages.push({
          from: fromNumber, sender: fromNumber, phoneNumber: fromNumber, number: fromNumber,
          text: messageText, body: messageText, message: messageText, content: messageText,
          code, timeText, timestamp,
          receivedAt: timestamp ? new Date(timestamp).toISOString() : null,
          id: `${fromNumber}-${timestamp || Date.now()}-${Math.random()}`,
        });
      }
    }
    return messages;
  }

  private parseRelativeTime(timeText: string): number | null {
    if (!timeText) return null;
    const now = Date.now();
    const text = timeText.toLowerCase().trim();
    
    const patterns = [
      { regex: /(\d+)\s*(?:second|sec)s?\s*ago/, multiplier: 1000 },
      { regex: /(\d+)\s*(?:minute|min)s?\s*ago/, multiplier: 60 * 1000 },
      { regex: /(\d+)\s*(?:hour|hr)s?\s*ago/, multiplier: 60 * 60 * 1000 },
      { regex: /(\d+)\s*(?:day|days?)\s*ago/, multiplier: 24 * 60 * 60 * 1000 },
    ];
    
    for (const { regex, multiplier } of patterns) {
      const match = text.match(regex);
      if (match) return now - parseInt(match[1]) * multiplier;
    }
    return null;
  }

  private extractJsonFromHtml(html: string): any[] | null {
    const jsonPatterns = [
      /var\s+messages\s*=\s*(\[.*?\]);/s,
      /window\.messages\s*=\s*(\[.*?\]);/s,
      /const\s+messages\s*=\s*(\[.*?\]);/s,
      /let\s+messages\s*=\s*(\[.*?\]);/s,
      /"messages"\s*:\s*(\[.*?\])/s,
      /data-messages=['"](.*?)['"]/s,
      /messages:\s*(\[.*?\])/s,
    ];
    
    for (const pattern of jsonPatterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch {}
      }
    }
    return null;
  }

  private extractMessagesFromJson(data: any): any[] {
    if (Array.isArray(data)) return data;
    if (data.messages) return data.messages;
    if (data['hydra:member']) return data['hydra:member'];
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.sms)) return data.sms;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.results)) return data.results;
    
    for (const key in data) {
      if (Array.isArray(data[key])) return data[key];
    }
    return [];
  }

  private async tryEndpoint(endpoint: string): Promise<any[] | null> {
    try {
      const res = await axios.get(endpoint, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.receivesms.co/'
        },
        timeout: 10000
      });
      
      const contentType = res.headers['content-type'] || '';
      const isJson = contentType.includes('application/json') || 
                    (typeof res.data === 'object' && !Array.isArray(res.data) && res.data !== null);
      
      if (isJson) {
        const messages = this.extractMessagesFromJson(res.data);
        if (messages.length > 0) {
          console.log(`✅ Fetched ${messages.length} messages from API: ${endpoint}`);
          return messages;
        }
      } else {
        const htmlMessages = this.parseMessagesFromHtml(res.data);
        if (htmlMessages.length > 0) {
          console.log(`✅ Parsed ${htmlMessages.length} messages from HTML: ${endpoint}`);
          return htmlMessages;
        }
        
        const jsonMessages = this.extractJsonFromHtml(res.data);
        if (jsonMessages) {
          console.log(`✅ Parsed ${jsonMessages.length} messages from JSON in HTML: ${endpoint}`);
          return jsonMessages;
        }
      }
    } catch (err: any) {
      if (err.response?.status !== 404) {
        console.log(`⚠️ Endpoint ${endpoint} failed: ${err.message}`);
      }
    }
    return null;
  }

  async getMessages(): Promise<any[]> {
    try {
      const phoneId = this.apiUrl.split('/').pop() || this.apiUrl.split('/').slice(-2)[0];
      const apiEndpoints = [
        `${this.apiUrl}/`, this.apiUrl,
        `https://www.receivesms.co/api/${phoneId}/`,
        `https://www.receivesms.co/api/${phoneId}`,
        `https://www.receivesms.co/us-phone-number/${phoneId}/`,
        `https://www.receivesms.co/us-phone-number/${phoneId}`,
        `${this.apiUrl}/api`,
        `https://www.receivesms.co/api/us-phone-number/${phoneId}`,
        `https://www.receivesms.co/api/us-phone-number/${phoneId}/`,
      ];

      for (const endpoint of apiEndpoints) {
        const messages = await this.tryEndpoint(endpoint);
        if (messages) return messages;
      }
      
      console.warn(`⚠️ No messages found from ${this.apiUrl}`);
      return [];
    } catch (error: any) {
      console.warn(`Error fetching SMS messages: ${error.message}`);
      return [];
    }
  }
}

/* -------------------- Utilities -------------------- */
export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sortMessagesByTimestamp(messages: any[]): any[] {
  return messages.sort((a, b) => {
    const tsA = getMessageTimestamp(a);
    const tsB = getMessageTimestamp(b);
    if (tsA && tsB) return tsB - tsA;
    if (tsA) return -1;
    if (tsB) return 1;
    return 0;
  });
}

function isDNVerificationMessage(msg: any): boolean {
  const messageText = getMessageText(msg);
  const dnVerificationPattern = /DN verification code/i;
  return dnVerificationPattern.test(messageText);
}

function filterDNVerificationMessages(messages: any[]): any[] {
  return messages.filter((msg) => isDNVerificationMessage(msg));
}

function isMessageInTimeWindow(msgTimestamp: number | null, now: number): boolean {
  if (!msgTimestamp) return false;
  const ageMs = now - msgTimestamp;
  return ageMs >= MIN_AGE_MS && ageMs <= MAX_AGE_MS;
}

/* -------------------- SMS wait & extraction -------------------- */
async function waitForNewSms(
  smsClient: ReceiveSmsApiClient,
  previousSmsId?: string,
  startAfter: number | null = null
) {
  console.log(`⏳ Waiting for new DN verification code SMS...`);
  
  const timeoutMs = SAFE_TIMEOUT_MS;
  const maxAttempts = Math.ceil(timeoutMs / SMS_POLL_INTERVAL_MS);
  let latestTimestampSeen: number | null = startAfter;
  let latestMessageSeen: any = null;
  
  for (let i = 0; i < maxAttempts; i++) {
    const messages = await smsClient.getMessages();
    
    if (messages.length === 0) {
      console.log(`No messages found (attempt ${i + 1}), continuing...`);
      await delay(SMS_POLL_INTERVAL_MS);
      continue;
    }
    
    if (i === 0) {
      console.log(`📨 Fetched ${messages.length} total message(s)`);
      messages.slice(0, 3).forEach((msg: any, idx: number) => {
        const text = getMessageText(msg).substring(0, 50);
        const ts = getMessageTimestamp(msg);
        const ageSeconds = ts ? Math.floor((Date.now() - ts) / 1000) : null;
        console.log(`  Message ${idx + 1}: age=${ageSeconds}s, text="${text}..."`);
      });
    }
    
    const sortedMessages = sortMessagesByTimestamp(messages);
    const filteredMessages = filterDNVerificationMessages(sortedMessages);
    
    console.log(`🔍 Filtered to ${filteredMessages.length} DN verification message(s)`);
    
    const now = Date.now();
    for (const msg of filteredMessages) {
      const msgId = getMessageId(msg);
      const msgTimestamp = getMessageTimestamp(msg);
      
      if (previousSmsId && msgId === previousSmsId) continue;
      if (startAfter && msgTimestamp && msgTimestamp < startAfter) continue;
      if (latestTimestampSeen && msgTimestamp && msgTimestamp <= latestTimestampSeen) continue;
      
      const ageMs = msgTimestamp ? now - msgTimestamp : Infinity;
      const ageSeconds = Math.floor(ageMs / 1000);
      
      if (ageMs < MIN_AGE_MS) {
        console.log(`⏳ Message too new (${ageSeconds}s), waiting...`);
        continue;
      }
      if (ageMs > MAX_AGE_MS) {
        console.log(`⏭️ Message too old (${ageSeconds}s, >30s), skipping...`);
        continue;
      }
      
      const otp = getOtpFromMessage(msg);
      if (!otp) {
        console.log(`⚠️ Found DN verification message but no OTP: "${getMessageText(msg).substring(0, 50)}..."`);
        continue;
      }
      
      if (msgTimestamp && (!latestTimestampSeen || msgTimestamp > latestTimestampSeen)) {
        latestTimestampSeen = msgTimestamp;
        latestMessageSeen = msg;
      }
      
      const isLatestMessage = filteredMessages.indexOf(msg) === 0;
      if (isLatestMessage && isMessageInTimeWindow(msgTimestamp, now)) {
        console.log(`✅ Latest DN verification SMS received! OTP: ${otp}, Age: ${ageSeconds}s`);
        
        await delay(2000);
        const finalCheck = await smsClient.getMessages();
        const finalSorted = sortMessagesByTimestamp(finalCheck);
        const finalFiltered = filterDNVerificationMessages(finalSorted);
        
        if (finalFiltered.length > 0) {
          const newestFinal = finalFiltered[0];
          const newestTs = getMessageTimestamp(newestFinal);
          const newestOtp = getOtpFromMessage(newestFinal);
          
          if (newestTs && msgTimestamp && newestTs > msgTimestamp && newestOtp && 
              isMessageInTimeWindow(newestTs, Date.now())) {
            const newestAgeSeconds = Math.floor((Date.now() - newestTs) / 1000);
            console.log(`🔄 Found newer message! Using OTP: ${newestOtp}, Age: ${newestAgeSeconds}s`);
            return { id: getMessageId(newestFinal), otp: newestOtp, message: newestFinal };
          }
        }
        
        return { id: msgId, otp, message: msg };
      }
    }
    
    if (filteredMessages.length > 0) {
      const latestMsg = filteredMessages[0];
      const latestTs = getMessageTimestamp(latestMsg);
      if (latestTs && (!latestTimestampSeen || latestTs > latestTimestampSeen)) {
        latestTimestampSeen = latestTs;
        latestMessageSeen = latestMsg;
        const ageSeconds = Math.floor((Date.now() - latestTs) / 1000);
        console.log(`📊 Latest DN verification message timestamp: ${ageSeconds}s ago`);
      }
    }
    
    await delay(SMS_POLL_INTERVAL_MS);
  }
  
  if (latestMessageSeen) {
    const msgTimestamp = getMessageTimestamp(latestMessageSeen);
    if (msgTimestamp && isMessageInTimeWindow(msgTimestamp, Date.now())) {
      const otp = getOtpFromMessage(latestMessageSeen);
      if (otp) {
        const ageSeconds = Math.floor((Date.now() - msgTimestamp) / 1000);
        console.log(`⚠️ Timeout reached, using latest message. OTP: ${otp}, Age: ${ageSeconds}s`);
        return { id: getMessageId(latestMessageSeen), otp, message: latestMessageSeen };
      }
    }
  }
  
  throw new Error(`No new DN verification SMS arrived within timeout (looking for messages under 30s old).`);
}

/* -------------------- UI Helpers -------------------- */
export async function tryClickAny(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      if (await loc.count()) {
        await loc.first().scrollIntoViewIfNeeded();
        await loc.first().click({ force: false });
        return true;
      }
    } catch {}
  }
  return false;
}

async function ensureSMSSelected(page: Page): Promise<boolean> {
  console.log('🔍 Checking if SMS is already selected...');
  await page.waitForTimeout(1200);
  
  const otpInputVisible = await page.locator('#auth-password').isVisible().catch(() => false);
  if (otpInputVisible) {
    console.log('✅ OTP input already visible - SMS was already selected');
    return true;
  }
  
  let isSMSSelected = false;
  try {
    const combobox = page.getByRole('combobox', { name: /Authentication Method/i });
    const selectedText = await combobox.textContent().catch(() => null);
    isSMSSelected = selectedText?.includes('SMS') || selectedText?.includes('Phone') || false;
    
    if (isSMSSelected) {
      console.log('✅ SMS is already selected');
      return true;
    }
    if (selectedText?.includes('Email')) {
      console.log('⚠️ Email is selected, switching to SMS...');
    }
  } catch {
    console.log('⚠️ Could not determine selection, will ensure SMS is selected...');
  }
  
  if (!isSMSSelected) {
    console.log('🔄 Switching to SMS option...');
    try {
      await page.getByRole('combobox', { name: /Authentication Method/i }).locator('svg').click();
      await page.waitForTimeout(500);
      await page.getByRole('option', { name: 'SMS' }).click();
      await page.waitForTimeout(500);
      console.log('✅ Selected SMS option');
    } catch {
      console.warn('⚠️ Codegen selector failed, trying fallback...');
      await tryClickAny(page, ['mat-select', 'select', '[role="combobox"]', '.mat-mdc-select', '.mat-select']);
      await page.waitForTimeout(500);
      const clicked = await tryClickAny(page, [
        '#mat-option-0', 'mat-option:has-text("Phone")', 'mat-option:has-text("SMS")',
        '[role="option"]:has-text("SMS")', 'text=SMS'
      ]);
      if (!clicked) throw new Error('Failed to select Phone/SMS option');
      await page.waitForTimeout(500);
    }
  }
  return true;
}

/* -------------------- Main Reusable Function -------------------- */
export interface SMSAuthOptions {
  page: Page;
  smsClient: ReceiveSmsApiClient;
  userEmail: string;
  userPassword: string;
  loginUrl?: string;
  waitAfterLogin?: number;
}

/**
 * Reusable function to perform SMS 2FA authentication flow.
 * 
 * @param options - Configuration options for the authentication flow
 * @returns Promise that resolves when login is complete
 * 
 * @example
 * ```typescript
 * import { loginWithSMS2FA, ReceiveSmsApiClient } from '../utils/smsAuth';
 * 
 * const smsClient = new ReceiveSmsApiClient(RECEIVE_SMS_URL, SENDER_PHONE_NUMBER);
 * 
 * await loginWithSMS2FA({
 *   page: appPage,
 *   smsClient,
 *   userEmail: DOC_EMAIL,
 *   userPassword: DOC_PASSWORD,
 *   loginUrl: 'https://dev-app.doctornow.io/login'
 * });
 * ```
 */
export async function loginWithSMS2FA(options: SMSAuthOptions): Promise<void> {
  const {
    page,
    smsClient,
    userEmail,
    userPassword,
    loginUrl = 'https://dev-app.doctornow.io/login',
    waitAfterLogin = 10000
  } = options;

  console.log('--- SMS FLOW START ---');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.fill('#user-email', userEmail);
  await page.fill('#user-password', userPassword);
  
  const clicked = await tryClickAny(page, ['.mdc-button__label', 'button[type="submit"]', 'button:has-text("Login")']);
  if (!clicked) await page.press('#user-password', 'Enter');

  await ensureSMSSelected(page);

  const inboxBefore = await smsClient.getMessages();
  const lastSmsId = inboxBefore[0]?.id || inboxBefore[0]?.messageId || inboxBefore[0]?._id;

  const otpAlreadySent = await page.locator('#auth-password').isVisible().catch(() => false);
  if (!otpAlreadySent) {
    await delay(500);
    const startAfter = Date.now();
    console.log(`Recorded Send click timestamp: ${startAfter}`);
    await tryClickAny(page, ['button:has-text("Send")', 'button:has-text("Send OTP")', 'button:has-text("Continue")', '.mdc-button__label']);
    const newSms = await waitForNewSms(smsClient, lastSmsId, startAfter);
    console.log(`SMS OTP found = ${newSms.otp}`);
    await page.fill('#auth-password', newSms.otp);
    await page.press('#auth-password', 'Enter');
  } else {
    console.log('OTP already sent, proceeding to fetch SMS...');
    const newSms = await waitForNewSms(smsClient, lastSmsId, null);
    console.log(`SMS OTP found = ${newSms.otp}`);
    await page.fill('#auth-password', newSms.otp);
    await page.press('#auth-password', 'Enter');
  }

  console.log(`Waiting ${waitAfterLogin}ms for page to fully load...`);
  await delay(waitAfterLogin);
  await page.waitForSelector('.mat-mdc-menu-trigger.profile_pic, .mat-mdc-menu-trigger, .mat-mdc-button-touch-target', { timeout: 10000 });
  console.log('✅ Logged in using SMS 2FA - Profile menu is now available');
}




