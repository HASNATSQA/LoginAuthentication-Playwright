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

/* -------------------- SMS API client (receivesms.co) -------------------- */
class ReceiveSmsApiClient {
  private apiUrl: string;
  public senderPhoneNumber: string;

  constructor(receiveSmsUrl: string, senderPhoneNumber: string) {
    // Extract API endpoint from receivesms.co URL
    // URL format: https://www.receivesms.co/us-phone-number/21157/
    this.apiUrl = receiveSmsUrl.replace(/\/$/, ''); // Remove trailing slash
    this.senderPhoneNumber = senderPhoneNumber;
  }

  private parseMessagesFromHtml(html: string): any[] {
    const messages: any[] = [];
    
    // Match article elements with entry-card class
    // Structure: <article class="entry-card type--default">...</article>
    const articleRegex = /<article[^>]*class="[^"]*entry-card[^"]*"[^>]*>(.*?)<\/article>/gs;
    let articleMatch;
    
    while ((articleMatch = articleRegex.exec(html)) !== null) {
      const articleHtml = articleMatch[1];
      
      // Extract sender phone number from: <a href="/who-called-me/13345649589/" class="from-link">13345649589</a>
      const fromMatch = articleHtml.match(/<a[^>]*href="[^"]*who-called-me\/(\d+)[^"]*"[^>]*class="[^"]*from-link[^"]*"[^>]*>(\d+)<\/a>/);
      const fromNumber = fromMatch ? (fromMatch[2] || fromMatch[1]) : '';
      
      // Extract code from: <span class="chip" data-code="738528"> or <strong class="code" data-code="738528">738528</strong>
      const codeMatch = articleHtml.match(/<strong[^>]*class="[^"]*code[^"]*"[^>]*data-code="(\d+)"[^>]*>(\d+)<\/strong>/) ||
                       articleHtml.match(/<span[^>]*class="[^"]*chip[^"]*"[^>]*data-code="(\d+)"[^>]*>/);
      const code = codeMatch ? (codeMatch[2] || codeMatch[1]) : '';
      
      // Extract message text from: <div class="sms">...</div>
      const smsMatch = articleHtml.match(/<div[^>]*class="[^"]*sms[^"]*"[^>]*>(.*?)<\/div>/s);
      const messageText = smsMatch ? smsMatch[1].replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
      
      // Extract time from: <span class="muted">39 seconds ago</span>
      const timeMatch = articleHtml.match(/<span[^>]*class="[^"]*muted[^"]*"[^>]*>([^<]+)<\/span>/);
      const timeText = timeMatch ? timeMatch[1].trim() : '';
      
      // Parse relative time to timestamp
      const timestamp = this.parseRelativeTime(timeText);
      
      if (fromNumber || messageText) {
        messages.push({
          from: fromNumber,
          sender: fromNumber,
          phoneNumber: fromNumber,
          number: fromNumber,
          text: messageText,
          body: messageText,
          message: messageText,
          content: messageText,
          code: code,
          timeText: timeText,
          timestamp: timestamp,
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
    
    // Parse patterns like "39 seconds ago", "8 minutes ago", "1 hour ago", "1 day ago"
    const secondMatch = text.match(/(\d+)\s*(?:second|sec)s?\s*ago/);
    if (secondMatch) {
      return now - parseInt(secondMatch[1]) * 1000;
    }
    
    const minuteMatch = text.match(/(\d+)\s*(?:minute|min)s?\s*ago/);
    if (minuteMatch) {
      return now - parseInt(minuteMatch[1]) * 60 * 1000;
    }
    
    const hourMatch = text.match(/(\d+)\s*(?:hour|hr)s?\s*ago/);
    if (hourMatch) {
      return now - parseInt(hourMatch[1]) * 60 * 60 * 1000;
    }
    
    const dayMatch = text.match(/(\d+)\s*(?:day|days?)\s*ago/);
    if (dayMatch) {
      return now - parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
    }
    
    return null;
  }

  async getMessages() {
    try {
      // Extract phone number ID from URL (e.g., 21314 from /us-phone-number/21314/)
      const phoneId = this.apiUrl.split('/').pop() || this.apiUrl.split('/').slice(-2)[0];
      
      // The API endpoint is likely the same URL but returns JSON
      // Based on network tab showing "21314/", try various API patterns
      const apiEndpoints = [
        `${this.apiUrl}/`,  // Same URL with trailing slash (as mentioned: "21314/")
        this.apiUrl,        // Same URL without trailing slash
        `https://www.receivesms.co/api/${phoneId}/`,  // Direct API path with phone ID
        `https://www.receivesms.co/api/${phoneId}`,   // Direct API path without trailing slash
        `https://www.receivesms.co/us-phone-number/${phoneId}/`,  // Reconstruct with phone ID
        `https://www.receivesms.co/us-phone-number/${phoneId}`,    // Without trailing slash
        `${this.apiUrl}/api`,
        `https://www.receivesms.co/api/us-phone-number/${phoneId}`,
        `https://www.receivesms.co/api/us-phone-number/${phoneId}/`,
      ];

      for (const endpoint of apiEndpoints) {
        try {
          // Try with JSON accept header first
          const res = await axios.get(endpoint, {
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.receivesms.co/'
            },
            timeout: 10000
          });
          
          // Check if response is JSON
          const contentType = res.headers['content-type'] || '';
          const isJson = contentType.includes('application/json') || 
                        typeof res.data === 'object' && !Array.isArray(res.data) && res.data !== null;
          
          // Handle different API response formats
          let messages: any[] = [];
          
          if (isJson) {
            // Direct JSON response
            // Log the structure for debugging
            if (endpoint === `${this.apiUrl}/` || endpoint === this.apiUrl) {
              console.log(`📡 API Response structure from ${endpoint}:`, Object.keys(res.data));
            }
            
            if (Array.isArray(res.data)) {
              messages = res.data;
            } else if (res.data.messages) {
              messages = res.data.messages;
            } else if (res.data['hydra:member']) {
              messages = res.data['hydra:member'];
            } else if (res.data.data) {
              messages = Array.isArray(res.data.data) ? res.data.data : [];
            } else if (res.data.sms) {
              messages = Array.isArray(res.data.sms) ? res.data.sms : [];
            } else if (res.data.items) {
              messages = Array.isArray(res.data.items) ? res.data.items : [];
            } else if (res.data.results) {
              messages = Array.isArray(res.data.results) ? res.data.results : [];
            } else {
              // If we got JSON but don't recognize the structure, log it
              console.log(`⚠️ Unknown JSON structure. Keys: ${Object.keys(res.data).join(', ')}`);
              // Try to find any array in the response
              for (const key in res.data) {
                if (Array.isArray(res.data[key])) {
                  messages = res.data[key];
                  console.log(`📦 Found array in key: ${key}`);
                  break;
                }
              }
            }
            
            if (messages.length > 0) {
              console.log(`✅ Successfully fetched ${messages.length} messages from API endpoint: ${endpoint}`);
              return messages;
            } else if (isJson && Object.keys(res.data).length > 0) {
              // Log sample of what we got for debugging
              console.log(`⚠️ Got JSON response but no messages array. Sample:`, JSON.stringify(res.data).substring(0, 200));
            }
          } else {
            // HTML response - parse messages from HTML structure
            const html = res.data;
            const messages = this.parseMessagesFromHtml(html);
            
            if (messages.length > 0) {
              console.log(`✅ Successfully parsed ${messages.length} messages from HTML at: ${endpoint}`);
              return messages;
            }
            
            // Fallback: try to extract JSON from script tags
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
              const jsonMatch = html.match(pattern);
              if (jsonMatch) {
                try {
                  const parsed = JSON.parse(jsonMatch[1]);
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    console.log(`✅ Successfully parsed ${parsed.length} messages from JSON in HTML at: ${endpoint}`);
                    return parsed;
                  }
                } catch (e) {
                  continue;
                }
              }
            }
          }
        } catch (err: any) {
          // Log error but continue to next endpoint
          if (err.response?.status !== 404) {
            console.log(`⚠️ Endpoint ${endpoint} failed: ${err.message}`);
          }
          continue;
        }
      }
      
      console.warn(`⚠️ No messages found from ${this.apiUrl} - tried ${apiEndpoints.length} endpoints`);
      return [];
    } catch (error: any) {
      console.warn(`Error fetching SMS messages from ${this.apiUrl}:`, error.message);
      return [];
    }
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
  // First check if timestamp is already a number
  if (typeof msg.timestamp === 'number') {
    return msg.timestamp;
  }
  
  const candidates = ['timestamp', 'createdAt', 'updatedAt', '@timestamp', 'date', 'receivedAt', 'sentAt'];
  for (const c of candidates) {
    if (msg[c]) {
      if (typeof msg[c] === 'number') {
        return msg[c];
      }
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
      console.log(' New 2FA email received!');
      return latest;
    }
    
    await new Promise(res => setTimeout(res, 3000));
  }
  
  throw new Error('No new 2FA email arrived within 30 seconds.');
}

/* -------------------- SMS wait & extraction (API-based) -------------------- */
async function waitForNewSms(smsClient: ReceiveSmsApiClient, previousSmsId?: string, startAfter: number | null = null) {
  console.log(`⏳ Waiting for new 2FA SMS from ${smsClient.senderPhoneNumber}...`);
  
  const start = Date.now();
  const timeoutMs = SAFE_TIMEOUT_MS;
  
  // Track the latest timestamp we've seen so far
  let latestTimestampSeen: number | null = startAfter || null;
  let latestMessageSeen: any = null;
  
  // Try polling for new SMS (similar to email flow)
  for (let i = 0; i < Math.ceil(timeoutMs / SMS_POLL_INTERVAL_MS); i++) {
    // Fetch fresh messages (this will refresh the page)
    const messages = await smsClient.getMessages();
    
    if (messages.length === 0) {
      console.log(`No messages found (attempt ${i + 1}), continuing...`);
      await delay(SMS_POLL_INTERVAL_MS);
      continue;
    }
    
    console.log(`📨 Fetched ${messages.length} total message(s) (attempt ${i + 1})`);
    
    // Log first few messages for debugging (only on first attempt)
    if (i === 0 && messages.length > 0) {
      console.log('Sample messages structure:');
      messages.slice(0, 3).forEach((msg: any, idx: number) => {
        const from = msg.from || msg.sender || msg.phoneNumber || msg.number || 'unknown';
        const text = (msg.text || msg.body || msg.message || msg.content || '').substring(0, 50);
        const ts = getMessageTimestamp(msg);
        const ageSeconds = ts ? Math.floor((Date.now() - ts) / 1000) : null;
        console.log(`  Message ${idx + 1}: from=${from}, timestamp=${ts}, age=${ageSeconds}s, text="${text}..."`);
      });
    }
    
    // Sort messages by timestamp (newest first)
    const sortedMessages = messages.sort((a: any, b: any) => {
      const tsA = getMessageTimestamp(a);
      const tsB = getMessageTimestamp(b);
      if (tsA && tsB) return tsB - tsA; // newest first
      if (tsA) return -1; // a has timestamp, b doesn't - a is newer
      if (tsB) return 1;  // b has timestamp, a doesn't - b is newer
      return 0; // neither has timestamp
    });
    
    // Filter for messages from the sender phone number
    const senderPhone = smsClient.senderPhoneNumber.replace(/\D/g, ''); // Remove non-digits
    const filteredMessages = sortedMessages.filter((msg: any) => {
      const fromNumber = (msg.from || msg.sender || msg.phoneNumber || msg.number || '').replace(/\D/g, '');
      const messageText = (msg.text || msg.body || msg.message || msg.content || '').toLowerCase();
      
      // Check if message is from sender phone number
      const fromSender = fromNumber.includes(senderPhone) || senderPhone.includes(fromNumber);
      
      // Also check if message contains DoctorNow/DN keywords (optional)
      const hasDoctorNow = messageText.includes('doctornow') || messageText.includes('dn');
      
      return fromSender || hasDoctorNow;
    });
    
    console.log(`🔍 Filtered to ${filteredMessages.length} message(s) from sender ${smsClient.senderPhoneNumber}`);
    
    // Find the latest message with OTP that is within the acceptable time window (1-30 seconds ago)
    const now = Date.now();
    const MIN_AGE_MS = 1000; // 1 second
    const MAX_AGE_MS = 30000; // 30 seconds
    
    for (const msg of filteredMessages) {
      const msgId = msg.id || msg.messageId || msg._id || JSON.stringify(msg);
      const msgTimestamp = getMessageTimestamp(msg);
      
      // Skip if this is the previous message (by ID)
      if (previousSmsId && msgId === previousSmsId) {
        continue;
      }
      
      // If startAfter is provided, only accept messages after that timestamp
      if (startAfter && msgTimestamp && msgTimestamp < startAfter) {
        continue;
      }
      
      // Only accept messages that are newer than the latest we've seen
      if (latestTimestampSeen && msgTimestamp && msgTimestamp <= latestTimestampSeen) {
        // This message is not newer, skip it
        continue;
      }
      
      // Check if message is within acceptable time window (1-30 seconds ago)
      if (msgTimestamp) {
        const ageMs = now - msgTimestamp;
        const ageSeconds = Math.floor(ageMs / 1000);
        
        if (ageMs < MIN_AGE_MS) {
          // Message is too new (less than 1 second old) - might be still processing, continue polling
          console.log(`⏳ Message is too new (${ageSeconds}s old), waiting for it to stabilize...`);
          continue;
        } else if (ageMs > MAX_AGE_MS) {
          // Message is too old (more than 30 seconds old) - skip and continue polling for newer one
          console.log(`⏭️ Message is too old (${ageSeconds}s old), continuing to check for newer messages...`);
          continue;
        }
      }
      
      // Extract OTP from message
      // First try the code field (extracted from HTML)
      let otp = msg.code || null;
      
      // If no code field, extract from message text
      if (!otp) {
        const messageText = msg.text || msg.body || msg.message || msg.content || '';
        otp = extract6DigitOtpFromText(messageText);
      }
      
      if (otp) {
        // Update latest seen timestamp
        if (msgTimestamp && (!latestTimestampSeen || msgTimestamp > latestTimestampSeen)) {
          latestTimestampSeen = msgTimestamp;
          latestMessageSeen = msg;
        }
        
        // If this is the absolute latest message (first in sorted list) and within time window, return it
        const isLatestMessage = filteredMessages.indexOf(msg) === 0;
        
        if (isLatestMessage && msgTimestamp) {
          const ageSeconds = Math.floor((now - msgTimestamp) / 1000);
          const fromNumber = msg.from || msg.sender || msg.phoneNumber || msg.number || 'unknown';
          
          // Double-check it's still within the acceptable window
          if (ageSeconds >= 1 && ageSeconds <= 30) {
            console.log(`✅ Latest 2FA SMS received! From: ${fromNumber}, OTP: ${otp}, Age: ${ageSeconds}s`);
            
            // Wait a bit more to ensure no newer message arrives
            await delay(2000);
            
            // Check one more time for an even newer message
            const finalCheck = await smsClient.getMessages();
            const finalSorted = finalCheck.sort((a: any, b: any) => {
              const tsA = getMessageTimestamp(a);
              const tsB = getMessageTimestamp(b);
              if (tsA && tsB) return tsB - tsA;
              return 0;
            });
            
            const finalFiltered = finalSorted.filter((m: any) => {
              const fromNum = (m.from || m.sender || m.phoneNumber || m.number || '').replace(/\D/g, '');
              return fromNum.includes(senderPhone) || senderPhone.includes(fromNum);
            });
            
            if (finalFiltered.length > 0) {
              const newestFinal = finalFiltered[0];
              const newestTs = getMessageTimestamp(newestFinal);
              const newestOtp = newestFinal.code || extract6DigitOtpFromText(newestFinal.text || newestFinal.body || newestFinal.message || newestFinal.content || '');
              
              // If there's a newer message with OTP within the time window, use that instead
              if (newestTs && msgTimestamp && newestTs > msgTimestamp && newestOtp) {
                const newestAgeSeconds = Math.floor((Date.now() - newestTs) / 1000);
                if (newestAgeSeconds >= 1 && newestAgeSeconds <= 30) {
                  console.log(`🔄 Found even newer message! Using OTP: ${newestOtp}, Age: ${newestAgeSeconds}s`);
                  return { id: newestFinal.id || JSON.stringify(newestFinal), otp: newestOtp, message: newestFinal };
                }
              }
            }
            
            return { id: msgId, otp, message: msg };
          } else {
            // Message is outside the window, continue polling
            console.log(`⏭️ Latest message is outside time window (${ageSeconds}s), continuing to check...`);
            continue;
          }
        }
      } else {
        // Log if we found a message but no OTP
        const fromNumber = msg.from || msg.sender || msg.phoneNumber || msg.number || 'unknown';
        const messageText = msg.text || msg.body || msg.message || msg.content || '';
        console.log(`⚠️ Found message from ${fromNumber} but no OTP: "${messageText.substring(0, 50)}..."`);
      }
    }
    
    // Update latest timestamp seen if we found messages
    if (filteredMessages.length > 0) {
      const latestMsg = filteredMessages[0];
      const latestTs = getMessageTimestamp(latestMsg);
      if (latestTs && (!latestTimestampSeen || latestTs > latestTimestampSeen)) {
        latestTimestampSeen = latestTs;
        latestMessageSeen = latestMsg;
        const ageSeconds = Math.floor((Date.now() - latestTs) / 1000);
        console.log(`📊 Latest message timestamp seen: ${latestTs} (${new Date(latestTs).toISOString()}, ${ageSeconds}s ago)`);
      }
      
      console.log(`Found ${filteredMessages.length} message(s) from sender, continuing to check for newer ones within 1-30s window...`);
    } else {
      console.log(`No messages from ${smsClient.senderPhoneNumber} yet, continuing...`);
    }
    
    await delay(SMS_POLL_INTERVAL_MS);
  }
  
  // If we have a latest message seen but didn't return, check if it's within the time window
  if (latestMessageSeen) {
    const msgTimestamp = getMessageTimestamp(latestMessageSeen);
    if (msgTimestamp) {
      const ageSeconds = Math.floor((Date.now() - msgTimestamp) / 1000);
      if (ageSeconds >= 1 && ageSeconds <= 30) {
        const otp = latestMessageSeen.code || extract6DigitOtpFromText(latestMessageSeen.text || latestMessageSeen.body || latestMessageSeen.message || latestMessageSeen.content || '');
        if (otp) {
          console.log(`⚠️ Timeout reached, using latest message found within time window. OTP: ${otp}, Age: ${ageSeconds}s`);
          return { id: latestMessageSeen.id || JSON.stringify(latestMessageSeen), otp, message: latestMessageSeen };
        }
      } else {
        console.log(`⚠️ Timeout reached, but latest message is outside time window (${ageSeconds}s old)`);
      }
    }
  }
  
  throw new Error(`No new 2FA SMS from ${smsClient.senderPhoneNumber} arrived within timeout period (or none found within 1-30 second window).`);
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

  const DOC_EMAIL = process.env.DOC_EMAIL;
  const DOC_PASSWORD = process.env.DOC_PASSWORD;
  const MAILTM_EMAIL = process.env.MAILTM_EMAIL;
  const MAILTM_PASSWORD = process.env.MAILTM_PASSWORD;
  const RECEIVE_SMS_URL = process.env.RECEIVE_SMS_URL || 'https://www.receivesms.co/us-phone-number/21314/';
  const SENDER_PHONE_NUMBER = process.env.SENDER_PHONE_NUMBER || '13345649589';

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

  console.log(`📱 Using SMS URL: ${RECEIVE_SMS_URL}`);
  console.log(`📱 Looking for messages from: ${SENDER_PHONE_NUMBER}`);
  const smsClient = new ReceiveSmsApiClient(RECEIVE_SMS_URL, SENDER_PHONE_NUMBER);

  // -------- EMAIL FLOW --------
  async function loginUsingEmailFlow() {
    console.log('--- EMAIL FLOW START ---');

    await appPage.goto('https://dev-app.doctornow.io/login', { waitUntil: 'domcontentloaded' });

    await appPage.fill('#user-email', DOC_EMAIL!);
    await appPage.fill('#user-password', DOC_PASSWORD!);

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

    console.log('Waiting 7 seconds for page to fully load after 2FA entry...');
    await delay(7000); // Wait 7 seconds as page takes time to load
    
    // Wait for profile menu to be available
    await appPage.waitForSelector('.mat-mdc-menu-trigger.profile_pic, .mat-mdc-menu-trigger, .mat-mdc-button-touch-target', { timeout: 10000 });
    console.log('Logged in using Email 2FA - Profile menu is now available');
  }

  // -------- PHONE FLOW --------
  async function loginUsingPhoneFlow() {
    console.log('--- PHONE FLOW START ---');
    await appPage.goto('https://dev-app.doctornow.io/login', { waitUntil: 'domcontentloaded' });

    await appPage.fill('#user-email', DOC_EMAIL!);
    await appPage.fill('#user-password', DOC_PASSWORD!);

    const clicked = await tryClickAny(appPage, ['.mdc-button__label', 'button[type="submit"]', 'button:has-text("Login")']);
    if (!clicked) await appPage.press('#user-password', 'Enter');

    // Wait for 2FA dropdown/page to load
    await appPage.waitForTimeout(1200);

    // Check if OTP input field is already visible (meaning OTP was already sent)
    const otpInputVisible = await appPage.locator('#auth-password').isVisible().catch(() => false);
    if (otpInputVisible) {
      console.log('OTP input already visible - proceeding directly to fetch SMS...');
    } else {
      // Always explicitly select Phone/SMS to ensure Email is not selected
      console.log(' Ensuring Phone/SMS option is selected from dropdown...');
      
      try {
        // Open dropdown using codegen selector - try different names
        console.log('   → Opening dropdown...');
        try {
          await appPage.getByRole('combobox', { name: /Authentication Method/i }).locator('svg').click();
        } catch {
          // Try with exact name if regex doesn't work
          await appPage.getByRole('combobox', { name: 'Authentication Method Email' }).locator('svg').click();
        }
        console.log('   Dropdown opened');
        await appPage.waitForTimeout(500);
        
        // Select SMS option using codegen selector
        console.log('   → Selecting SMS option...');
        await appPage.getByRole('option', { name: 'SMS' }).click();
        console.log('   Selected SMS option');
      } catch (e) {
        console.warn('   Codegen selector failed, trying fallback...');
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
          throw new Error('Failed to select Phone/SMS option from dropdown - cannot proceed');
        }
      }
    }

    // Get inbox BEFORE clicking Send - similar to email flow
    const inboxBefore = await smsClient.getMessages();
    const lastSmsId = inboxBefore[0]?.id || inboxBefore[0]?.messageId || inboxBefore[0]?._id;

    // If there's a button to send OTP (try several) - but only if OTP input is not already visible
    const otpAlreadySent = await appPage.locator('#auth-password').isVisible().catch(() => false);
    if (!otpAlreadySent) {
      // Record timestamp BEFORE clicking Send to ensure we only get SMS sent after this moment
      await delay(500);
      const startAfter = Date.now();
      console.log(`Recorded Send click timestamp: ${startAfter} (will only accept SMS after this)`);
      
      // Click Send button
      await tryClickAny(appPage, ['button:has-text("Send")', 'button:has-text("Send OTP")', 'button:has-text("Continue")', '.mdc-button__label']);
      
      // Wait for NEW SMS (similar to email flow)
      const newSms = await waitForNewSms(smsClient, lastSmsId, startAfter);
      console.log(`SMS OTP found = ${newSms.otp}`);

      await appPage.fill('#auth-password', newSms.otp);
      await appPage.press('#auth-password', 'Enter');
    } else {
      console.log('OTP already sent, proceeding to fetch SMS...');
      const newSms = await waitForNewSms(smsClient, lastSmsId, null);
      console.log(`SMS OTP found = ${newSms.otp}`);
      
      await appPage.fill('#auth-password', newSms.otp);
      await appPage.press('#auth-password', 'Enter');
    }

    console.log('Waiting 10 seconds for page to fully load after 2FA entry...');
    await delay(10000); // Wait 15 seconds as page takes time to load
    
    // Wait for profile menu to be available
    await appPage.waitForSelector('.mat-mdc-menu-trigger.profile_pic, .mat-mdc-menu-trigger, .mat-mdc-button-touch-target', { timeout: 10000 });
    console.log('Logged in using Phone 2FA - Profile menu is now available');
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

    await loginUsingPhoneFlow();
    await logoutFromProfile();

    console.log('Both flows completed successfully');
  } catch (err) {
    console.error('Test failed:', err);
    try { await appPage.screenshot({ path: 'failure-app.png' }); } catch {}
    throw err;
  } finally {
    try { await appPage.close(); } catch {}
  }
});