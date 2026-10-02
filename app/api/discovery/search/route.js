import { getActiveDiscoverySearchCorpus } from '../../../../lib/datasets/public';

// Shared public search data. It is generated independently of the initial
// Discovery page and only requested after a visitor starts searching.
export const dynamic = 'force-static';
export const revalidate = 300;

export async function GET() {
  const corpus = await getActiveDiscoverySearchCorpus({ requireAvailable: true });
  return Response.json(corpus);
}
