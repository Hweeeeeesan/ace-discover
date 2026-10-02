import DiscoveryFeed from '../components/DiscoveryFeed';
import { getActiveDataset } from '../lib/datasets/public';

// Discovery is shared public output. Admin mutations invalidate this page on
// demand, while the five-minute ISR window is a safety net for any external
// data change that did not pass through an ACE Admin route.
export const dynamic = 'force-static';
export const revalidate = 300;

export default async function Home() {
  // A failed ISR regeneration must throw so Next keeps serving the last good
  // page instead of caching the temporary "unavailable" response.
  const dataset = await getActiveDataset({ requireAvailable: true });
  return (
    <DiscoveryFeed
      key={dataset.slug}
      profiles={dataset.profiles}
      datasetSlug={dataset.slug}
      searchCorpusVersion={dataset.searchCorpusVersion}
    />
  );
}
