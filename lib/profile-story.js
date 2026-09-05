function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberedItems(value) {
  const lines = clean(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || !lines.every((line) => /^\d{1,2}[.)]\s+/.test(line))) return [];
  return lines.map((line) => line.replace(/^\d{1,2}[.)]\s+/, '').trim()).filter(Boolean);
}

function hobbyItems(hobbies, details) {
  const names = clean(hobbies).split(/\r?\n|[,;]+/).map((item) => item.trim()).filter(Boolean);
  const explanationLines = clean(details).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = explanationLines.map((line) => {
    const match = line.match(/^([^:–—-]{2,50})\s*[:–—-]\s*(.+)$/);
    return match ? { name: match[1].trim(), detail: match[2].trim() } : null;
  }).filter(Boolean);
  if (parsed.length >= 2) return parsed;
  return names.length && !details ? names.map((name) => ({ name })) : [];
}

export function normalizeProfileStory(profile = {}) {
  const story = {
    tagline: clean(profile.tagline),
    uniqueThings: numberedItems(profile.uniqueThings),
    uniqueThingsText: clean(profile.uniqueThings),
    passion: clean(profile.passion),
    perfectDay: clean(profile.perfectDay),
    hobbies: clean(profile.hobbies),
    hobbyDetails: clean(profile.hobbyDetails),
    hobbyItems: hobbyItems(profile.hobbies, profile.hobbyDetails),
    music: clean(profile.music),
    moviesTv: clean(profile.movies || profile.moviesTv),
    idealHangout: clean(profile.idealHangout),
    bucketList: clean(profile.bucketList),
    hotTake: clean(profile.hotTake),
  };
  story.isEditorial = Boolean(
    story.tagline || story.uniqueThingsText || story.passion || story.idealHangout
      || story.bucketList || story.hotTake || story.hobbyDetails,
  );
  return story;
}

export function normalizeProfileIntro(profile = {}, story = normalizeProfileStory(profile)) {
  const bio = clean(profile.bio);
  return {
    tagline: story.isEditorial ? story.tagline : '',
    bio: /^(?:little|big|family) applicant$/i.test(bio) ? '' : bio,
  };
}
