// Zod schemas mirroring the reels (Twitter/X overlay) template settings (twitterTemplateTypes.ts).
// Same design rules as carouselSchema.ts: strict objects, top-level-partial patches, drift guarded
// by editorTools.test.ts against defaultTwitterTemplateSettings().

import { z } from 'zod';
import { zFontWeight, zTextAlign, zShadowStyle } from './carouselSchema';

const pct = z.number().min(0).max(100);

export const zAvatarShape = z.enum(['roundedSquare', 'circle']);
export const zReelsCellType = z.enum(['empty', 'banner', 'text', 'image', 'bannerText']);

export const zBannerStyle = z.strictObject({
  showAvatar: z.boolean().optional(),
  avatarShape: zAvatarShape.optional(),
  avatarUrl: z.string().optional(),
  avatarStroke: z.boolean().optional(),
  avatarStrokeColor: z.string().optional(),
  avatarStrokeWidth: z.number().optional(),
  avatarImageScale: z.number().optional(),
  avatarOffsetX: z.number().optional(),
  avatarOffsetY: z.number().optional(),
  avatarSize: z.number().optional(),
  showName: z.boolean().optional(),
  nameColor: z.string().optional(),
  nameFontSize: z.number().optional(),
  showHandle: z.boolean().optional(),
  handleColor: z.string().optional(),
  handleFontSize: z.number().optional(),
  showVerified: z.boolean().optional(),
  defaultDisplayName: z.string().nullable().optional(),
  defaultHandle: z.string().nullable().optional(),
  headerPaddingX: z.number().optional(),
  headerPaddingTop: z.number().optional(),
  nameHandleGap: z.number().optional(),
  nameHandleOffsetX: z.number().optional(),
  nameHandleOffsetY: z.number().optional(),
});

export const zReelsTextStyle = z.strictObject({
  fontLabel: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: zFontWeight.optional(),
  italic: z.boolean().optional(),
  allCaps: z.boolean().optional(),
  color: z.string().optional(),
  align: zTextAlign.optional(),
  paddingTop: z.number().optional(),
  vAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  growDir: z.enum(['down', 'up']).optional(),
  letterSpacing: z.number().optional(),
  lineHeight: z.number().optional(),
  opacity: pct.optional(),
  shadow: zShadowStyle.optional(),
  captionColor: z.string().optional(),
  captionFontSize: z.number().optional(),
  captionLineHeight: z.number().optional(),
});

export const zReelsImageStyle = z.strictObject({
  fit: z.enum(['cover', 'contain']).optional(),
  bgColor: z.string().optional(),
  cornerRadius: z.number().optional(),
  imageScale: z.number().optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  border: z.boolean().optional(),
  borderColor: z.string().optional(),
  borderWidth: z.number().optional(),
});

const reelsCellFields = {
  type: zReelsCellType,
  text: z.string().optional(),
  isCaption: z.boolean().optional(),
  textStyle: zReelsTextStyle.optional(),
  imageUrl: z.string().optional(),
  imageStyle: zReelsImageStyle.optional(),
  banner: zBannerStyle.optional(),
  bannerTextGap: z.number().optional(),
};

export const zReelsCell = z.strictObject(reelsCellFields);

export const zReelsFreeElement = z.strictObject({
  ...reelsCellFields,
  id: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  hidden: z.boolean().optional(),
});

export const zTwitterTemplateSettings = z.strictObject({
  headerBgColor: z.string(),
  nameColor: z.string(),
  handleColor: z.string(),
  captionColor: z.string(),
  captionFontSize: z.number(),
  avatarShape: zAvatarShape,
  showAvatar: z.boolean(),
  avatarStroke: z.boolean().optional(),
  avatarStrokeColor: z.string().optional(),
  avatarStrokeWidth: z.number().optional(),
  avatarImageScale: z.number().optional(),
  avatarOffsetX: z.number().optional(),
  avatarOffsetY: z.number().optional(),
  showName: z.boolean(),
  showHandle: z.boolean(),
  showVerified: z.boolean(),
  defaultDisplayName: z.string().nullable(),
  defaultHandle: z.string().nullable(),
  headerPaddingX: z.number().optional(),
  headerPaddingTop: z.number().optional(),
  avatarSize: z.number().optional(),
  captionGap: z.number().optional(),
  nameFontSize: z.number().optional(),
  handleFontSize: z.number().optional(),
  captionLineHeight: z.number().optional(),
  nameHandleGap: z.number().optional(),
  nameHandleOffsetX: z.number().optional(),
  nameHandleOffsetY: z.number().optional(),
  videoPaddingX: z.number().optional(),
  cellTop: zReelsCell.optional(),
  cellTop2: zReelsCell.optional(),
  cellBottom: zReelsCell.optional(),
  cellBottom2: zReelsCell.optional(),
  videoBandHeight: z.number().optional(),
  videoCornerRadius: z.number().optional(),
  cellMargin: z.number().optional(),
  freeElements: z.array(zReelsFreeElement).optional(),
  videoLayer: z.number().optional(),
});

// A patch: top-level fields optional, AND the cell objects accept PARTIAL cells so the model can
// tweak one cell field (e.g. { cellTop: { textStyle: { color } } }) without resending the whole
// cell — the bridge deep-merges, so a partial cell preserves its `type` + siblings. (zReelsCell's
// nested banner/textStyle/imageStyle are already all-optional, so only `type` needs relaxing here.)
// freeElements stays a whole-array replace (each element is complete, id required).
const zReelsCellPatch = zReelsCell.partial();
export const zTwitterTemplateSettingsPatch = zTwitterTemplateSettings.partial().extend({
  cellTop: zReelsCellPatch.optional(),
  cellTop2: zReelsCellPatch.optional(),
  cellBottom: zReelsCellPatch.optional(),
  cellBottom2: zReelsCellPatch.optional(),
});

export type TwitterTemplateSettingsPatch = z.infer<typeof zTwitterTemplateSettingsPatch>;
