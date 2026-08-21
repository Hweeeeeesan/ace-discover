import DiscoveryFeed from '../components/DiscoveryFeed';
import { getActiveDataset } from '../lib/datasets/public';

// The active dataset and image presentation metadata can be edited by Admins.
// Read the public RPC on each request instead of serving a build-time snapshot.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const dataset = await getActiveDataset();
  return <DiscoveryFeed key={dataset.slug} profiles={dataset.profiles} datasetSlug={dataset.slug} />;
}
