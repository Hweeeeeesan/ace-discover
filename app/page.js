import DiscoveryFeed from '../components/DiscoveryFeed';
import { profiles } from '../lib/profiles';

export default function Home() {
  return <DiscoveryFeed profiles={profiles} />;
}
