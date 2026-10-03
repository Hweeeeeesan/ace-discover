export function filterEligibleDiscoveryProfiles(profiles = [], showFamilyInDiscovery = true) {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => showFamilyInDiscovery !== false || profile?.role !== 'Family');
}
