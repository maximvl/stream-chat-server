import { type } from 'arktype'

export const UserResponseSchema = type({
  data: type({
    id: 'string',
    login: 'string',
    display_name: 'string',
    type: 'string',
    broadcaster_type: 'string',
    description: 'string',
    profile_image_url: 'string',
    offline_image_url: 'string',
    view_count: 'number',
    created_at: 'string',
  }).array(),
})

export const BadgeResponseSchema = type({
  data: type({
    set_id: 'string',
    versions: type({
      id: 'string',
      image_url_1x: 'string',
      image_url_2x: 'string',
      image_url_4x: 'string',
      title: 'string',
      description: 'string',
    }).array(),
  }).array(),
})

export const CheermotesResponseSchema = type({
  data: type({
    prefix: 'string',
    tiers: type({
      min_bits: 'number',
      color: 'string',
      images: {
        dark: { animated: { '4': 'string' } },
      },
    }).array(),
  }).array(),
})

export const RewardsResponseSchema = type({
  data: {
    channel: type({
      'communityPointsSettings?': type({
        customRewards: type({
          id: 'string',
          title: 'string',
          'prompt?': 'string | null',
          'cost?': 'number',
          'backgroundColor?': 'string | null',
        }).array(),
      }).or('null'),
    }).or('null'),
  },
})

export type BadgeVersion =
  (typeof BadgeResponseSchema.infer)['data'][number]['versions'][number]
