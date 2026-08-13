import DiscoveryFeed from '../components/DiscoveryFeed';
import { profiles } from '../lib/profiles';

export default function Home() {
  const discoveryProfiles = profiles.map((profile) => {
    const discoveryProfile = { ...profile };
    delete discoveryProfile.instagram;
    return discoveryProfile;
  });

  return <DiscoveryFeed profiles={discoveryProfiles} />;
}
