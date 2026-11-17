import { SeededRandom } from './history-random';

// Short, varied review texts. Each is built from parts that do not name a
// product, so they fit any garment in the catalog. Plain English, no emojis.
type Sentiment = 'positive' | 'mixed' | 'negative';

const TITLES: Record<Sentiment, readonly string[]> = {
  positive: [
    'Love it',
    'Exactly what I wanted',
    'Great quality',
    'Very comfortable',
    'Worth the price',
    'Perfect fit',
    'Better than expected',
    'My new favourite',
    'Would buy again',
    'Soft and well made',
    'Nice everyday piece',
    'Happy with this',
  ],
  mixed: [
    'Good, with one small issue',
    'Decent for the price',
    'Fine overall',
    'Nice but not perfect',
    'Okay',
    'Does the job',
    'Mixed feelings',
  ],
  negative: [
    'Not what I hoped for',
    'Disappointed',
    'Runs small',
    'Quality could be better',
    'Would not buy again',
    'Poor fit',
  ],
};

const OPENERS: Record<Sentiment, readonly string[]> = {
  positive: [
    'The fabric feels great against the skin.',
    'It fits just as the size guide said.',
    'Arrived quickly and looks even better in person.',
    'The stitching is neat and the material feels solid.',
    'I have worn it several times already.',
    'The colour matches the photos.',
    'Very easy to wear with what I already own.',
    'Light enough for the weather here and still looks smart.',
    'Bought it as a gift and it was well received.',
    'The cut is flattering without being tight.',
  ],
  mixed: [
    'The material is good and the colour is right.',
    'It is comfortable once you get the size right.',
    'The look is nice and the price is fair.',
    'It arrived on time and is well packed.',
    'The design is simple, which is what I wanted.',
  ],
  negative: [
    'It runs smaller than the size chart suggests.',
    'The fabric is thinner than I expected.',
    'The colour looks different from the photos.',
    'It started to lose its shape after a wash.',
    'The fit around the shoulders is off for me.',
  ],
};

const DETAILS: Record<Sentiment, readonly string[]> = {
  positive: [
    'It held up well in the wash.',
    'Washed twice and nothing has changed.',
    'I get compliments every time I wear it.',
    'It is warm without feeling heavy.',
    'Good length for my height.',
    'The pockets are actually useful.',
    'It does not wrinkle much, which helps.',
    'Sizing was easy to pick from the table.',
  ],
  mixed: [
    'The sleeves are a little long for me.',
    'I would size down next time.',
    'It creases easily, but that is normal for this fabric.',
    'The colour is slightly darker than shown.',
    'Delivery took a day longer than I hoped.',
  ],
  negative: [
    'I had to ask about a return.',
    'I wore it once and it already looks tired.',
    'There were loose threads at the hem.',
    'I will stay with my usual brand.',
  ],
};

const CLOSERS: Record<Sentiment, readonly string[]> = {
  positive: [
    'Recommended.',
    'I will order another colour.',
    'Good value overall.',
    'Five minutes of ironing and it looks perfect.',
    'Thank you to the shop.',
  ],
  mixed: [
    'Still glad I bought it.',
    'Fine for everyday use.',
    'Fair for the price.',
  ],
  negative: [
    'Hoping the next batch is better.',
    'Not recommended at this price.',
  ],
};

export function sentimentForRating(rating: number): Sentiment {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'mixed';
  return 'negative';
}

export interface ReviewText {
  title: string;
  body: string | null;
}

export function buildReviewText(
  random: SeededRandom,
  rating: number,
): ReviewText {
  const sentiment = sentimentForRating(rating);
  const title = random.pick(TITLES[sentiment]);
  // About one review in ten is only a title.
  if (random.chance(0.1)) return { title, body: null };

  const parts = [random.pick(OPENERS[sentiment])];
  if (random.chance(0.6)) parts.push(random.pick(DETAILS[sentiment]));
  if (random.chance(0.4)) parts.push(random.pick(CLOSERS[sentiment]));
  return { title, body: parts.join(' ') };
}
