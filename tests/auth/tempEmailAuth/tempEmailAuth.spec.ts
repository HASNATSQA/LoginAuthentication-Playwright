import { test, Page } from '@playwright/test';
import dotenv from 'dotenv';
import { loginWithEmail2FA, MailTmClient, tryClickAny } from '../utils/emailAuth';

dotenv.config();

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
  // Using the reusable loginWithEmail2FA function
  async function loginUsingEmailFlow() {
    await loginWithEmail2FA({
      page: appPage,
      mailClient,
      userEmail: DOC_EMAIL!,
      userPassword: DOC_PASSWORD!,
      loginUrl: 'https://dev-app.doctornow.io/login',
      waitAfterLogin: 7000
    });
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