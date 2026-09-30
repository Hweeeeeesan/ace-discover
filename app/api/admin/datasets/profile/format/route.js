import { authorizeAdminReadRequest } from '../../../../../../lib/admin/authorization';
import { getAdminDatasetProfile } from '../../../../../../lib/datasets/admin';
import { analyzeProfileFormatting, applyDescriptionMatches } from '../../../../../../lib/profile-format-recommendations';
import { resolveEffectivePublicProfile } from '../../../../../../lib/profile-overrides';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const authorization = await authorizeAdminReadRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '').trim();
    if (!UUID.test(datasetId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profileId)) {
      return Response.json({ error: 'Invalid formatting review request.' }, { status: 400 });
    }
    const current = await getAdminDatasetProfile(datasetId, profileId);
    if (!current) return Response.json({ error: 'Profile not found in the requested dataset.' }, { status: 404 });
    const recommendation = analyzeProfileFormatting({
      hobbies: current.profile?.hobbies,
      hobbyDetails: current.profile?.hobbyDetails,
    });
    const appliedSuggestion = recommendation.canApply
      ? applyDescriptionMatches(current.profile?.hobbies, recommendation.suggested)
      : { ok: false };
    const downstreamPreview = appliedSuggestion.ok
      ? (() => {
        const next = resolveEffectivePublicProfile(current.importedPublicData, {
          ...current.publicOverrides,
          hobbyDetails: appliedSuggestion.hobbyDetails,
        });
        return {
          interests: next.interests || [],
          vibes: next.vibes || [],
        };
      })()
      : null;
    return Response.json({ ok: true, profileId, recommendation, downstreamPreview, appliedSuggestion });
  } catch (error) {
    return Response.json({ error: error.message || 'Formatting analysis failed.' }, { status: 422 });
  }
}
