import DiscoveryFeed from '../components/DiscoveryFeed';
import { getActiveDataset } from '../lib/datasets/public';

export default async function Home() {
  const dataset = await getActiveDataset();
  return <DiscoveryFeed key={dataset.slug} profiles={dataset.profiles} datasetSlug={dataset.slug} />;
}
