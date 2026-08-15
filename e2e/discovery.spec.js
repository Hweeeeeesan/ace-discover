import { test, expect } from '@playwright/test';
import { profiles } from '../lib/profiles.js';

const roleNames = ['All', 'Little', 'Big', 'Family'];

async function openDiscovery(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('ACE Discover', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
}

async function openFilters(page) {
  await page.getByRole('button', { name: /Open filters/ }).click();
  const dialog = page.getByRole('dialog', { name: 'More filters' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('ACE Discover discovery smoke tests', () => {
  test('loads discovery and supports every role', async ({ page }) => {
    await openDiscovery(page);

    for (const role of roleNames) {
      const button = page.getByRole('button', { name: role, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      for (const otherRole of roleNames.filter((candidate) => candidate !== role)) {
        await expect(page.getByRole('button', { name: otherRole, exact: true })).toHaveAttribute('aria-pressed', 'false');
      }
    }
  });

  test('combines independent Unseen with every role', async ({ page }) => {
    await openDiscovery(page);
    const unseen = page.getByRole('checkbox', { name: 'Show unseen profiles only' });

    for (const role of roleNames) {
      await page.getByRole('button', { name: role, exact: true }).click();
      await unseen.check();
      await expect(unseen).toBeChecked();
      await expect(page.locator('.result-announcer')).toContainText('profiles available');
      await unseen.uncheck();
      await expect(unseen).not.toBeChecked();
    }
  });

  test('opens and closes the advanced Filters sheet', async ({ page }) => {
    await openDiscovery(page);
    const dialog = await openFilters(page);
    await expect(dialog.getByText('Vibes', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close filters' }).click();
    await expect(dialog).toBeHidden();
  });

  test('selects multiple Vibes with OR behavior', async ({ page }) => {
    await openDiscovery(page);
    const dialog = await openFilters(page);
    await dialog.getByRole('button', { name: 'Music', exact: true }).click();
    await dialog.getByRole('button', { name: 'Anime', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Music', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'Anime', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: /^Apply/ }).click();
    await expect(page.getByRole('button', { name: /Open filters, 2 active/ })).toBeVisible();
  });

  test('applies Year and Major Area filters', async ({ page }) => {
    await openDiscovery(page);
    const dialog = await openFilters(page);
    await dialog.getByRole('button', { name: /^Second year/ }).click();
    await dialog.getByRole('button', { name: /^Business/ }).click();
    await dialog.getByRole('button', { name: /^Apply/ }).click();
    await expect(page.getByRole('button', { name: /Open filters, 2 active/ })).toBeVisible();
    await expect(page.locator('.result-announcer')).toContainText('profiles available');
  });

  test('interacts with Social Style and Social Level controls', async ({ page }) => {
    await openDiscovery(page);
    const dialog = await openFilters(page);
    await dialog.getByRole('button', { name: 'Ambivert', exact: true }).click();
    const minimum = dialog.getByRole('slider', { name: 'Minimum social level' });
    await minimum.focus();
    await minimum.press('ArrowRight');
    await minimum.press('ArrowRight');
    await expect(dialog.getByText('3–5', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Ambivert', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: /^Apply/ }).click();
    await expect(page.getByRole('button', { name: /Open filters, 2 active/ })).toBeVisible();
  });

  test('Reset filters clears advanced state but keeps role and Unseen', async ({ page }) => {
    await openDiscovery(page);
    await page.getByRole('button', { name: 'Big', exact: true }).click();
    const unseen = page.getByRole('checkbox', { name: 'Show unseen profiles only' });
    await unseen.check();
    const dialog = await openFilters(page);
    await dialog.getByRole('button', { name: 'Music', exact: true }).click();
    await dialog.getByRole('button', { name: 'Reset filters', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Music', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Big', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(unseen).toBeChecked();
    await expect(page.getByRole('button', { name: /Open filters$/ })).toBeVisible();
  });

  test('searches and opens a profile, then returns to discovery', async ({ page }) => {
    await openDiscovery(page);
    await page.getByRole('button', { name: 'Search profiles' }).click();
    const search = page.getByRole('searchbox', { name: 'Search profiles' });
    await search.fill('Ashley Kiang');
    await expect(page.getByRole('link', { name: /View profile/ }).first()).toBeVisible();
    await page.getByRole('link', { name: /View profile/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Ashley Kiang' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to discovery', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('searchbox', { name: 'Search profiles' })).toHaveValue('Ashley Kiang');
  });

  test('loads Admin and detail-page social/deck links', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'ACE Discover health' })).toBeVisible();
    await expect(page.getByText('Major Area distribution', { exact: true })).toBeVisible();
    await expect(page.getByText('Social Level distribution', { exact: true })).toBeVisible();

    const instagramProfile = profiles.find((profile) => profile.instagram);
    const deckProfile = profiles.find((profile) => profile.slideDeckUrl);
    await page.goto(`/profile/${instagramProfile.id}`);
    const instagram = page.getByRole('link', { name: /View Instagram/ });
    await expect(instagram).toHaveAttribute('target', '_blank');
    await expect(instagram).toHaveAttribute('rel', /noopener/);
    await page.goto(`/profile/${deckProfile.id}`);
    await expect(page.getByRole('link', { name: /View slide deck/ })).toHaveAttribute('target', '_blank');
  });

  test('has no document-level horizontal overflow', async ({ page }) => {
    await openDiscovery(page);
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(overflow.width).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewport);
  });
});
