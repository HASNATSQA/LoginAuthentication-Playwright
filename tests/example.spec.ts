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

  // loginWithEmail2FA already verifies the profile menu is available
  // After 2FA entry, it navigates to dashboard - wait for page to fully load
  console.log('✅ Successfully logged in using Email 2FA!');
  
  // Wait for dashboard to fully load
  await appPage.waitForLoadState('networkidle');
  
  // Wait for profile button to be visible using the working locator
  const profileButton = appPage.locator('span').nth(5);
  await profileButton.waitFor({ state: 'visible', timeout: 10000 });
  
  // Go to profile and logout
  await profileButton.click();
  await appPage.getByRole('menuitem', { name: 'exit_to_app Logout' }).click();
  console.log('✅ Successfully logged out!');
  
  // Verify logout was successful by checking Login button is visible
  await expect(appPage.getByRole('button', { name: 'Login' })).toBeVisible({ timeout: 10000 });

  // Clean up
  await appPage.close();
});
