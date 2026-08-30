import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductQueryDto, ProductSort } from './product-query.dto';

describe('ProductQueryDto Validation & Transformation', () => {
  async function transformAndValidate(raw: Record<string, unknown>) {
    const dto = plainToInstance(ProductQueryDto, raw);
    const errors = await validate(dto);
    return { dto, errors };
  }

  describe('Price query params', () => {
    it('accepts valid integer minPrice and maxPrice', async () => {
      const { dto, errors } = await transformAndValidate({
        minPrice: '200000',
        maxPrice: '500000',
      });
      expect(errors).toHaveLength(0);
      expect(dto.minPrice).toBe(200000);
      expect(dto.maxPrice).toBe(500000);
    });

    it('transforms empty string minPrice and maxPrice to undefined', async () => {
      const { dto, errors } = await transformAndValidate({
        minPrice: '',
        maxPrice: '   ',
      });
      expect(errors).toHaveLength(0);
      expect(dto.minPrice).toBeUndefined();
      expect(dto.maxPrice).toBeUndefined();
    });

    it('rejects fractional prices', async () => {
      const { errors } = await transformAndValidate({
        minPrice: '199.99',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'minPrice')).toBe(true);
    });

    it('rejects negative prices', async () => {
      const { errors } = await transformAndValidate({
        minPrice: '-50000',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'minPrice')).toBe(true);
    });

    it('rejects non-numeric strings and NaN', async () => {
      const { errors } = await transformAndValidate({
        minPrice: 'abc',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'minPrice')).toBe(true);
    });

    it('rejects when minPrice is strictly greater than maxPrice', async () => {
      const { errors } = await transformAndValidate({
        minPrice: '600000',
        maxPrice: '300000',
      });
      expect(errors.length).toBeGreaterThan(0);
      const minPriceError = errors.find((e) => e.property === 'minPrice');
      expect(minPriceError).toBeDefined();
      expect(minPriceError?.constraints?.isLessThanOrEqualProperty).toBe(
        'minPrice cannot be greater than maxPrice',
      );
    });

    it('allows minPrice equal to maxPrice', async () => {
      const { dto, errors } = await transformAndValidate({
        minPrice: '300000',
        maxPrice: '300000',
      });
      expect(errors).toHaveLength(0);
      expect(dto.minPrice).toBe(300000);
      expect(dto.maxPrice).toBe(300000);
    });
  });

  describe('Multi-value size & color normalization', () => {
    it('normalizes repeated query parameters', async () => {
      const { dto, errors } = await transformAndValidate({
        size: ['M', 'L'],
        color: ['Black', 'Navy'],
      });
      expect(errors).toHaveLength(0);
      expect(dto.size).toEqual(['M', 'L']);
      expect(dto.color).toEqual(['Black', 'Navy']);
    });

    it('normalizes comma-separated query parameters', async () => {
      const { dto, errors } = await transformAndValidate({
        size: 'M, L, XL',
        color: 'Washed Black, Sage Green',
      });
      expect(errors).toHaveLength(0);
      expect(dto.size).toEqual(['M', 'L', 'XL']);
      expect(dto.color).toEqual(['Washed Black', 'Sage Green']);
    });

    it('flattens and deduplicates mixed repeated and comma parameters', async () => {
      const { dto, errors } = await transformAndValidate({
        size: ['M, L', 'XL', 'M'],
        color: ['Black, Navy', 'Black'],
      });
      expect(errors).toHaveLength(0);
      expect(dto.size).toEqual(['M', 'L', 'XL']);
      expect(dto.color).toEqual(['Black', 'Navy']);
    });

    it('transforms empty/whitespace-only size/color to undefined', async () => {
      const { dto, errors } = await transformAndValidate({
        size: ' ,  ',
        color: ['', '  '],
      });
      expect(errors).toHaveLength(0);
      expect(dto.size).toBeUndefined();
      expect(dto.color).toBeUndefined();
    });
  });

  describe('Boolean inStock query param', () => {
    it('transforms truthy and falsy representations', async () => {
      const res1 = await transformAndValidate({ inStock: 'true' });
      expect(res1.dto.inStock).toBe(true);

      const res2 = await transformAndValidate({ inStock: '1' });
      expect(res2.dto.inStock).toBe(true);

      const res3 = await transformAndValidate({ inStock: 'false' });
      expect(res3.dto.inStock).toBe(false);

      const res4 = await transformAndValidate({ inStock: '0' });
      expect(res4.dto.inStock).toBe(false);

      const res5 = await transformAndValidate({ inStock: '' });
      expect(res5.dto.inStock).toBeUndefined();
    });

    it('rejects invalid boolean strings', async () => {
      const { errors } = await transformAndValidate({ inStock: 'maybe' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'inStock')).toBe(true);
    });
  });

  describe('Sort query param', () => {
    it('accepts valid sort enum values', async () => {
      for (const sort of Object.values(ProductSort)) {
        const { dto, errors } = await transformAndValidate({ sort });
        expect(errors).toHaveLength(0);
        expect(dto.sort).toBe(sort);
      }
    });

    it('rejects invalid sort enum values', async () => {
      const { errors } = await transformAndValidate({
        sort: 'unsupported_sort',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'sort')).toBe(true);
    });
  });
});
