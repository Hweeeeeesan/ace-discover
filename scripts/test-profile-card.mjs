import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const component = await readFile(new URL('../components/ProfileCard.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

assert.ok(component.includes('profile.tagline'), 'cards should consume the normalized tagline field');
assert.ok(component.includes('className="profile-tagline"'), 'cards should use the dedicated quote style');
for (const label of ['Quote:', 'Motto:', 'Personality:']) {
  assert.ok(!component.includes(label), `cards should not show the ${label} field label`);
}
assert.match(styles, /\.profile-tagline[\s\S]*?-webkit-line-clamp: 2/);
assert.match(styles, /@media \(max-width: 360px\)[\s\S]*?\.profile-tagline \{ -webkit-line-clamp: 1; \}/);
assert.ok(component.includes('SavedProfileButton'), 'bookmark behavior remains present');
assert.ok(component.includes('onOpenProfile?.(profile.id)'), 'profile navigation callback remains present');
console.log('Profile card tagline tests passed.');
