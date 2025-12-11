import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';
import { loginWithEmail2FA, MailTmClient } from './auth/utils/emailAuth';

dotenv.config();

test('Example: Login with Email 2FA', async ({ context }) => {
  test.setTimeout(6 * 60 * 1000); // 6 minutes overall

  const appPage = await context.newPage();

  // Get credentials from environment variables
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

  // Initialize Mail.tm client
  const mailClient = new MailTmClient();
  await mailClient.login(MAILTM_EMAIL!, MAILTM_PASSWORD!);

  // Use the reusable email authentication function - just one line!
  await loginWithEmail2FA({
    page: appPage,
    mailClient,
    userEmail: DOC_EMAIL!,
    userPassword: DOC_PASSWORD!,
    loginUrl: 'https://dev-app.doctornow.io/login',
    waitAfterLogin: 7000
  });

  // Now you can perform any actions after login
  // For example, verify you're logged in
  await expect(appPage.locator('.mat-mdc-menu-trigger.profile_pic, .mat-mdc-menu-trigger')).toBeVisible({ timeout: 10000 });
  console.log('✅ Successfully logged in using Email 2FA!');

  // Clean up
  await appPage.close();
});
