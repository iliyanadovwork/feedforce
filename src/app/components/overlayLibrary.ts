// Overlay-texture library hosted in the Supabase "overlay-textures" bucket.
// First 12 textures ported from sonotool. To add more: upload <id>.jpg to the
// bucket's overlays/ and overlays/thumbs/ folders, then extend OVERLAY_IDS.
export const OVERLAY_BUCKET = 'overlay-textures';
export const OVERLAY_IDS: string[] = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012'];
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const overlayUrl = (id: string) => `${BASE}/storage/v1/object/public/overlay-textures/overlays/${id}.jpg`;
export const overlayThumbUrl = (id: string) => `${BASE}/storage/v1/object/public/overlay-textures/overlays/thumbs/${id}.jpg`;
