import { test, expect } from '@playwright/test';
const knownRoles = ['All', 'Little', 'Big', 'Family'];

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

async function availableRoleNames(page) {
  const labels = await page.locator('.role-chip-scroll .filter-chip').allTextContents();
  return labels.map((label) => label.trim()).filter((label) => knownRoles.includes(label));
}

function profileRouteParts(href) {
  const match = String(href || '').match(/^\/profile\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error(`Expected a dataset-aware profile route, received ${href}`);
  return { datasetSlug: decodeURIComponent(match[1]), profileId: decodeURIComponent(match[2]) };
}

test.describe('ACE Discover discovery smoke tests', () => {
  test('loads discovery and supports every role', async ({ page }) => {
    await openDiscovery(page);

    const roleNames = await availableRoleNames(page);
    expect(roleNames).toContain('All');
    expect(roleNames.length).toBeGreaterThan(1);
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

    const roleNames = await availableRoleNames(page);
    for (const role of roleNames) {
      await page.getByRole('button', { name: role, exact: true }).click();
      await unseen.check();
      await expect(unseen).toBeChecked();
      await expect(page.locator('.result-announcer')).toContainText('profiles available');
      await unseen.uncheck();
      await expect(unseen).not.toBeChecked();
    }
  });

  test('bookmarks locally without opening the profile and syncs on detail', async ({ page }) => {
    await openDiscovery(page);
    const firstCard = page.locator('.profile-card').first();
    const profileId = await firstCard.getAttribute('data-profile-id');
    const profileHref = await firstCard.getByRole('link', { name: /View profile/ }).getAttribute('href');
    const { datasetSlug } = profileRouteParts(profileHref);
    const bookmark = firstCard.getByRole('button', { name: 'Save profile' });
    await expect(bookmark).toBeVisible();
    const feedUrl = page.url();
    await bookmark.click();
    await expect(page).toHaveURL(feedUrl);
    await expect(firstCard.getByRole('button', { name: 'Remove from saved' })).toBeVisible();
    await page.getByRole('button', { name: 'Show saved profiles only' }).click();
    await expect(page.locator('.result-announcer')).toContainText('1 profiles available');
    const stored = await page.evaluate(({ id, slug }) => ({
      ids: JSON.parse(localStorage.getItem(`ace-discover:saved:${slug}`) || '[]'),
      id,
    }), { id: profileId, slug: datasetSlug });
    expect(stored.ids).toContain(profileId);
    await firstCard.getByRole('link', { name: /View profile/ }).click();
    await expect(page.getByRole('button', { name: 'Remove from saved' })).toBeVisible();
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

  test('protects Admin and keeps detail-page social/deck links', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByText('ACE Discover Admin', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Admin setup required|Organizer access/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();

    await openDiscovery(page);
    const profileHrefs = await page.getByRole('link', { name: /View profile/ }).evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    let instagram = null;
    for (const href of profileHrefs.slice(0, 20)) {
      await page.goto(href, { waitUntil: 'domcontentloaded' });
      const candidate = page.getByRole('link', { name: /View Instagram/ });
      if (await candidate.count()) {
        instagram = candidate;
        break;
      }
    }
    expect(instagram).not.toBeNull();
    await expect(instagram).toHaveAttribute('target', '_blank');
    await expect(instagram).toHaveAttribute('rel', /noopener/);

    await openDiscovery(page);
    const deckCard = page.locator('.profile-card').filter({ has: page.getByRole('link', { name: /slide deck/i }) }).first();
    const deckProfileHref = await deckCard.getByRole('link', { name: /View profile/ }).getAttribute('href');
    await page.goto(deckProfileHref);
    await expect(page.getByRole('link', { name: /View slide deck/ })).toHaveAttribute('target', '_blank');
  });

  test('uses collision-safe profile routes and dataset-specific browser state', async ({ page }) => {
    await openDiscovery(page);
    const firstCard = page.locator('.profile-card').first();
    const name = await firstCard.locator('h2').textContent();
    const href = await firstCard.getByRole('link', { name: /View profile/ }).getAttribute('href');
    const { datasetSlug, profileId } = profileRouteParts(href);
    const otherDataset = datasetSlug === 'fall-2025' ? 'spring-2026' : 'fall-2025';
    await firstCard.getByRole('link', { name: /View profile/ }).click();
    await expect(page.getByRole('heading', { name: name.trim() })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/profile/${datasetSlug}/${profileId}$`));

    const state = await page.evaluate(({ slug, other }) => ({
      currentSeen: localStorage.getItem(`ace-discover:seen:${slug}`),
      otherSeen: localStorage.getItem(`ace-discover:seen:${other}`),
      currentSession: sessionStorage.getItem(`profile-gallery:discovery-v2:${slug}`),
      otherSession: sessionStorage.getItem(`profile-gallery:discovery-v2:${other}`),
    }), { slug: datasetSlug, other: otherDataset });
    expect(JSON.parse(state.currentSeen)).toContain(profileId);
    expect(state.otherSeen).toBeNull();
    expect(state.currentSession).not.toBeNull();
    expect(state.otherSession).toBeNull();
  });

  test('does not expose Admin dataset previews without authorization', async ({ page }) => {
    await page.goto('/admin/preview/00000000-0000-0000-0000-000000000000/ashley-kiang');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: /Admin setup required|Organizer access/ })).toBeVisible();
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

  test('keeps filter spacing compact and anchors Unseen to the right', async ({ page }) => {
    await openDiscovery(page);

    const roleStrip = page.locator('.role-control-strip');
    const roleScroll = roleStrip.locator('.role-chip-scroll');
    const unseen = roleStrip.locator('.unseen-toggle');
    const controlLayout = await Promise.all([
      roleStrip.boundingBox(),
      roleScroll.boundingBox(),
      unseen.boundingBox(),
    ]);
    const [stripBox, rolesBox, unseenBox] = controlLayout;
    expect(stripBox).not.toBeNull();
    expect(rolesBox).not.toBeNull();
    expect(unseenBox).not.toBeNull();
    expect(unseenBox.x + unseenBox.width).toBeGreaterThanOrEqual(stripBox.x + stripBox.width - 2);
    expect(unseenBox.x).toBeGreaterThan(rolesBox.x + rolesBox.width);

    const dialog = await openFilters(page);
    const sections = dialog.locator('.filter-fieldset');
    const sectionLayout = await sections.evaluateAll((nodes) => nodes.map((node) => {
      const legend = node.querySelector('legend').getBoundingClientRect();
      const control = node.querySelector('button, .social-range-summary').getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, legendBottom: legend.bottom, controlTop: control.top };
    }));
    expect(sectionLayout).toHaveLength(5);
    for (const section of sectionLayout) {
      expect(section.controlTop - section.legendBottom).toBeGreaterThanOrEqual(4);
      expect(section.controlTop - section.legendBottom).toBeLessThanOrEqual(40);
    }
    for (let index = 1; index < sectionLayout.length; index += 1) {
      const gap = sectionLayout[index].top - sectionLayout[index - 1].bottom;
      expect(gap).toBeGreaterThanOrEqual(16);
      expect(gap).toBeLessThanOrEqual(32);
    }

    const sheetOverflow = await dialog.evaluate((node) => {
      const scroll = node.querySelector('.sheet-scroll');
      const footer = node.querySelector('.sheet-footer');
      const scrollBox = scroll.getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      return {
        scrollable: scroll.scrollHeight >= scroll.clientHeight,
        footerTop: footerBox.y,
        scrollBottom: scrollBox.y + scrollBox.height,
        pageWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      };
    });
    expect(sheetOverflow.scrollable).toBeTruthy();
    expect(sheetOverflow.scrollBottom).toBeLessThanOrEqual(sheetOverflow.footerTop + 1);
    expect(sheetOverflow.pageWidth).toBeLessThanOrEqual(sheetOverflow.viewport);
  });
});
