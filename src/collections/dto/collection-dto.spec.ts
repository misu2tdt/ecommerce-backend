import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCollectionDto } from './create-collection.dto';
import { ReplaceCollectionProductsDto } from './replace-collection-products.dto';
import { UpdateCollectionDto } from './update-collection.dto';

async function check<T extends object>(
  type: new () => T,
  raw: Record<string, unknown>,
) {
  const dto = plainToInstance(type, raw);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const messages = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
  return { dto, errors, messages };
}

describe('CreateCollectionDto', () => {
  it('accepts a name alone', async () => {
    const { errors } = await check(CreateCollectionDto, {
      name: 'Everyday Essentials',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts every field', async () => {
    const { errors } = await check(CreateCollectionDto, {
      name: 'Everyday Essentials',
      slug: 'everyday-essentials',
      description: 'Simple pieces.',
      heroImageUrl: 'https://res.cloudinary.com/demo/image/upload/a.jpg',
      isActive: false,
      isFeatured: true,
      sortOrder: 3,
    });
    expect(errors).toHaveLength(0);
  });

  it('trims the name, the slug and the description', async () => {
    const { dto } = await check(CreateCollectionDto, {
      name: '  Layering Pieces ',
      slug: ' layering-pieces ',
      description: '  Light jackets.  ',
    });
    expect(dto.name).toBe('Layering Pieces');
    expect(dto.slug).toBe('layering-pieces');
    expect(dto.description).toBe('Light jackets.');
  });

  it.each([undefined, '', ' ', 'a', 'x'.repeat(121), 42])(
    'rejects the name %j',
    async (name) => {
      const { messages } = await check(CreateCollectionDto, { name });
      expect(messages.length).toBeGreaterThan(0);
    },
  );

  it('says why a name is rejected', async () => {
    const { messages } = await check(CreateCollectionDto, { name: 'a' });
    expect(messages).toContain('name must be between 2 and 120 characters');
  });

  it.each([
    'Has Spaces',
    'UPPER',
    'under_score',
    '-leading',
    'trailing-',
    'double--dash',
    `cafe${String.fromCharCode(0x301)}`,
  ])('rejects the slug %j', async (slug) => {
    const { messages } = await check(CreateCollectionDto, {
      name: 'Valid Name',
      slug,
    });
    expect(messages).toContain(
      'slug may only contain lowercase letters and numbers joined by single dashes',
    );
  });

  it('rejects a slug longer than 160 characters', async () => {
    const { messages } = await check(CreateCollectionDto, {
      name: 'Valid Name',
      slug: 'a'.repeat(161),
    });
    expect(messages).toContain('slug must not be longer than 160 characters');
  });

  it.each([
    'ftp://x.test/a.jpg',
    'not a url',
    '/relative/path.jpg',
    'javascript:alert(1)',
  ])('rejects the hero image address %j', async (heroImageUrl) => {
    const { messages } = await check(CreateCollectionDto, {
      name: 'Valid Name',
      heroImageUrl,
    });
    expect(messages).toContain(
      'heroImageUrl must be a valid http or https address',
    );
  });

  it.each([-1, 1.5, '3', 100_001, null])(
    'rejects a sortOrder of %j only when it is not a whole number from 0 to 100000',
    async (sortOrder) => {
      const { errors } = await check(CreateCollectionDto, {
        name: 'Valid Name',
        sortOrder,
      });
      // null counts as "not sent".
      expect(errors.length).toBe(sortOrder === null ? 0 : 1);
    },
  );

  it.each(['yes', 1, 'true'])('rejects %j as a flag', async (flag) => {
    const { errors } = await check(CreateCollectionDto, {
      name: 'Valid Name',
      isActive: flag,
      isFeatured: flag,
    });
    expect(errors.map((error) => error.property).sort()).toEqual([
      'isActive',
      'isFeatured',
    ]);
  });

  it('rejects fields it does not know', async () => {
    const { errors } = await check(CreateCollectionDto, {
      name: 'Valid Name',
      productIds: [1, 2],
    });
    expect(errors.map((error) => error.property)).toContain('productIds');
  });
});

describe('UpdateCollectionDto', () => {
  it('accepts an empty body and any single field', async () => {
    for (const body of [
      {},
      { name: 'New Name' },
      { isFeatured: true },
      { description: null },
      { sortOrder: 0 },
    ]) {
      const { errors } = await check(UpdateCollectionDto, body);
      expect(errors).toHaveLength(0);
    }
  });

  it('still validates what is sent', async () => {
    const { errors } = await check(UpdateCollectionDto, {
      name: 'a',
      slug: 'Bad Slug',
    });
    expect(errors.map((error) => error.property).sort()).toEqual([
      'name',
      'slug',
    ]);
  });
});

describe('ReplaceCollectionProductsDto', () => {
  it('accepts a list of ids, an empty list and exactly 200 ids', async () => {
    for (const productIds of [
      [4, 2, 9],
      [],
      Array.from({ length: 200 }, (_, index) => index + 1),
    ]) {
      const { errors } = await check(ReplaceCollectionProductsDto, {
        productIds,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects more than 200 ids', async () => {
    const { messages } = await check(ReplaceCollectionProductsDto, {
      productIds: Array.from({ length: 201 }, (_, index) => index + 1),
    });
    expect(messages).toContain(
      'productIds must not hold more than 200 products',
    );
  });

  it.each([undefined, null, 'abc', 7, { 0: 1 }])(
    'rejects %j instead of a list',
    async (productIds) => {
      const { messages } = await check(ReplaceCollectionProductsDto, {
        productIds,
      });
      expect(messages).toContain('productIds must be an array of product ids');
    },
  );

  it.each([[[1, '2']], [[1.5]], [[0]], [[-3]], [[null]], [['abc']]])(
    'rejects the list %j',
    async (productIds) => {
      const { errors } = await check(ReplaceCollectionProductsDto, {
        productIds,
      });
      expect(errors.length).toBeGreaterThan(0);
    },
  );
});
