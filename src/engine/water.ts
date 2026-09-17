/** The recommended wetsuit, from lightest to warmest. `full54Cold`: 5/4 with boots, gloves and hood. */
export type Wetsuit = 'lycra' | 'shorty' | 'full32' | 'full43' | 'full54' | 'full54Cold';

/**
 * The wetsuit for water at `waterC` °C, rounded to the nearest degree: the usual surf-shop scale. Boots
 * from the 5/4 up, plus gloves and a hood at 10 °C and below. One recommendation for everyone, same as
 * the star rating: not tuned for people who feel the cold more, or less.
 */
export function wetsuitFor(waterC: number): Wetsuit {
  if (waterC >= 24) return 'lycra';
  if (waterC >= 20) return 'shorty';
  if (waterC >= 17) return 'full32';
  if (waterC >= 14) return 'full43';
  if (waterC >= 11) return 'full54';
  return 'full54Cold';
}
