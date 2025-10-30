import { test, expect } from '@playwright/test';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();


class MailTmClient {
  private token: string = '';
  private accountId: string = '';
  private baseUrl = 'https://api.mail.tm';

  async login(email: string, password: string) {
    const res = await axios.post(`${this.baseUrl}/token`, {
      address: email,
      password,
    });
    this.token = res.data.token;
    this.accountId = res.data.id;
  }

  async getMessages() {
    const res = await axios.get(`${this.baseUrl}/messages`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data['hydra:member'];
  }

  async getMessageBody(id: string) {
    const res = await axios.get(`${this.baseUrl}/messages/${id}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data.text || res.data.intro || '';
  }
}


async function waitForNewEmail(mailClient: MailTmClient, previousEmailId?: string) {
  console.log('⏳ Waiting for new 2FA email...');

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


test('DoctorNow login and 2FA verification', async ({ page }) => {
  const mailClient = new MailTmClient();

  
  console.log('🔐 Logging into Mail.tm...');
  await mailClient.login(process.env.MAILTM_EMAIL!, process.env.MAILTM_PASSWORD!);

  
  const inboxBefore = await mailClient.getMessages();
  const lastEmailId = inboxBefore[0]?.id;

  
  console.log('Opening DoctorNow login...');
  await page.goto('https://dev-app.doctornow.io/login');

  await page.fill('#user-email', process.env.DOC_EMAIL!);
  await page.fill('#user-password', process.env.DOC_PASSWORD!);
  await page.click('.mdc-button__label');

  
  const newEmail = await waitForNewEmail(mailClient, lastEmailId);

  
  const emailBody = await mailClient.getMessageBody(newEmail.id);
  const otpMatch = emailBody.match(/\b\d{6}\b/);
  const otpCode = otpMatch ? otpMatch[0] : null;

  if (!otpCode) throw new Error('Could not find OTP in the email!');
  console.log(`Found OTP: ${otpCode}`);

  
  await page.fill('#auth-password', otpCode);
  await page.press('#auth-password', 'Enter');

  
  await expect(page).toHaveURL(/dashboard|home|profile/);
  console.log('🎉 2FA login successful!');
});
