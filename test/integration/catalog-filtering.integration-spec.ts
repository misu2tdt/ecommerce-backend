import { DataSource } from 'typeorm';
import { Brand } from '../../src/brands/entities/brand.entity';
import { Category } from '../../src/categories/entities/category.entity';
import { ImageStorageService } from '../../src/image-storage/image-storage.service';
import { ProductStatus } from '../../src/products/entities/product-status.enum';
import { ProductImage } from '../../src/products/entities/product-image.entity';
import { Product } from '../../src/products/entities/product.entity';
import { ProductSort } from '../../src/products/dto/product-query.dto';
import { ProductsService } from '../../src/products/products.service';
import { createCategory, createVariant } from './catalog-fixtures';
import { cleanTestDatabase, initializeTestDatabase } from './test-database';

describe('Catalog Filtering & Sorting PostgreSQL integration', () => {
  let dataSource: DataSource;
  let productsService: ProductsService;

  beforeAll(async () => {
    dataSource = await initializeTestDatabase();
    productsService = new ProductsService(
      dataSource.getRepository(Product),
      dataSource.getRepository(Category),
      dataSource.getRepository(Brand),
      dataSource.getRepository(ProductImage),
      { deleteImage: jest.fn() } as unknown as ImageStorageService,
    );
  });

  beforeEach(async () => cleanTestDatabase(dataSource));

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await cleanTestDatabase(dataSource);
      await dataSource.destroy();
    }
  });

  describe('Existing search, category, and brand filters', () => {
    it('filters by category slug, brand slug, and search term q', async () => {
      const catApparel = await createCategory(dataSource, 'apparel');
      const catPants = await createCategory(dataSource, 'pants');
      const brandVerve = await dataSource.getRepository(Brand).save({
        name: 'Verve',
        slug: 'verve',
      });
      const brandKanso = await dataSource.getRepository(Brand).save({
        name: 'Kanso',
        slug: 'kanso',
      });

      const p1 = await productsService.create({
        name: 'Verve Classic Tee',
        categoryId: catApparel.id,
        brandId: brandVerve.id,
      });
      await createVariant(dataSource, p1, 'V-TEE', {
        price: 200_000,
        stock: 5,
      });

      const p2 = await productsService.create({
        name: 'Kanso Essential Tee',
        categoryId: catApparel.id,
        brandId: catPants.id ? brandKanso.id : undefined,
      });
      await createVariant(dataSource, p2, 'K-TEE', {
        price: 220_000,
        stock: 5,
      });

      const p3 = await productsService.create({
        name: 'Verve Relaxed Pants',
        categoryId: catPants.id,
        brandId: brandVerve.id,
      });
      await createVariant(dataSource, p3, 'V-PANTS', {
        price: 400_000,
        stock: 5,
      });

      // Filter by category
      const catResults = await productsService.findAll({
        category: catApparel.slug,
      });
      expect(catResults.map((p) => p.name).sort()).toEqual([
        'Kanso Essential Tee',
        'Verve Classic Tee',
      ]);

      // Filter by brand
      const brandResults = await productsService.findAll({
        brand: 'verve',
      });
      expect(brandResults.map((p) => p.name).sort()).toEqual([
        'Verve Classic Tee',
        'Verve Relaxed Pants',
      ]);

      // Filter by search term q
      const searchResults = await productsService.findAll({
        q: 'relaxed',
      });
      expect(searchResults.map((p) => p.name)).toEqual(['Verve Relaxed Pants']);
    });
  });

  describe('Size and color multi-value filtering & conjunction', () => {
    it('filters by size and color with coherent single-variant conjunction', async () => {
      const category = await createCategory(dataSource, 'apparel');
      const brand = await dataSource.getRepository(Brand).save({
        name: 'Verve',
        slug: 'verve',
      });

      // Product A: Has M/White and L/Black (no single M/Black variant)
      const productA = await productsService.create({
        name: 'Split Variant Shirt',
        categoryId: category.id,
        brandId: brand.id,
      });
      await createVariant(dataSource, productA, 'VAR-A1', {
        attributes: { size: 'M', color: 'White' },
        price: 250_000,
        stock: 5,
      });
      await createVariant(dataSource, productA, 'VAR-A2', {
        attributes: { size: 'L', color: 'Black' },
        price: 250_000,
        stock: 5,
      });

      // Product B: Has M/Black (qualifies for size=M AND color=Black)
      const productB = await productsService.create({
        name: 'Matching Variant Shirt',
        categoryId: category.id,
        brandId: brand.id,
      });
      await createVariant(dataSource, productB, 'VAR-B1', {
        attributes: { size: 'M', color: 'Black' },
        price: 300_000,
        stock: 10,
      });

      // 1. Filter size=M (matches both Product A and Product B)
      const sizeMResults = await productsService.findAll({ size: ['M'] });
      expect(sizeMResults.map((p) => p.name)).toEqual(
        expect.arrayContaining([
          'Matching Variant Shirt',
          'Split Variant Shirt',
        ]),
      );
      expect(sizeMResults).toHaveLength(2);

      // 2. Filter color=Black (matches both Product A and Product B)
      const colorBlackResults = await productsService.findAll({
        color: ['Black'],
      });
      expect(colorBlackResults).toHaveLength(2);

      // 3. Conjunction: size=M AND color=Black
      // Product A has M/White and L/Black -> NO single variant matches -> must NOT qualify!
      // Product B has M/Black -> DOES qualify!
      const conjunctionResults = await productsService.findAll({
        size: ['M'],
        color: ['Black'],
      });
      expect(conjunctionResults.map((p) => p.name)).toEqual([
        'Matching Variant Shirt',
      ]);
      expect(conjunctionResults).toHaveLength(1);
    });

    it('filters by multiple sizes and colors in repeated array form (OR within facet)', async () => {
      const category = await createCategory(dataSource, 'multi-facet');
      const product1 = await productsService.create({
        name: 'Size S Tee',
        categoryId: category.id,
      });
      await createVariant(dataSource, product1, 'TEE-S', {
        attributes: { size: 'S', color: 'Heather Grey' },
        price: 150_000,
        stock: 5,
      });

      const product2 = await productsService.create({
        name: 'Size XL Tee',
        categoryId: category.id,
      });
      await createVariant(dataSource, product2, 'TEE-XL', {
        attributes: { size: 'XL', color: 'Navy Blue' },
        price: 180_000,
        stock: 5,
      });

      const product3 = await productsService.create({
        name: 'Size M Tee',
        categoryId: category.id,
      });
      await createVariant(dataSource, product3, 'TEE-M', {
        attributes: { size: 'M', color: 'Olive' },
        price: 160_000,
        stock: 5,
      });

      // Query size: S or XL
      const multiSize = await productsService.findAll({ size: ['S', 'XL'] });
      expect(multiSize.map((p) => p.name).sort()).toEqual(
        ['Size S Tee', 'Size XL Tee'].sort(),
      );

      // Query color with space: "Heather Grey" or "Navy Blue"
      const multiColor = await productsService.findAll({
        color: ['Heather Grey', 'Navy Blue'],
      });
      expect(multiColor.map((p) => p.name).sort()).toEqual(
        ['Size S Tee', 'Size XL Tee'].sort(),
      );
    });

    it('enforces coherent variant conjunction between size and price range', async () => {
      const category = await createCategory(dataSource, 'conjunction');

      // Product has Size M @ 600,000 and Size L @ 200,000
      const prod = await productsService.create({
        name: 'Tiered Tee',
        categoryId: category.id,
      });
      await createVariant(dataSource, prod, 'TIER-M', {
        attributes: { size: 'M' },
        price: 600_000,
        stock: 5,
      });
      await createVariant(dataSource, prod, 'TIER-L', {
        attributes: { size: 'L' },
        price: 200_000,
        stock: 5,
      });

      // Query size=M and maxPrice=300_000
      // Size M costs 600k -> does NOT satisfy price <= 300k
      // Size L costs 200k -> satisfies price <= 300k, but NOT size=M
      // Result: 0 products
      const emptyResults = await productsService.findAll({
        size: ['M'],
        maxPrice: 300_000,
      });
      expect(emptyResults).toHaveLength(0);

      // Query size=L and maxPrice=300_000 -> matches!
      const matchingResults = await productsService.findAll({
        size: ['L'],
        maxPrice: 300_000,
      });
      expect(matchingResults.map((p) => p.name)).toEqual(['Tiered Tee']);
    });
  });

  describe('Price range filtering', () => {
    it('filters by minPrice, maxPrice, and price range', async () => {
      const category = await createCategory(dataSource, 'pricing');
      const budget = await productsService.create({
        name: 'Budget Shirt',
        categoryId: category.id,
      });
      await createVariant(dataSource, budget, 'BUDGET', {
        price: 120_000,
        stock: 5,
      });

      const mid = await productsService.create({
        name: 'Midrange Shirt',
        categoryId: category.id,
      });
      await createVariant(dataSource, mid, 'MID', {
        price: 350_000,
        stock: 5,
      });

      const premium = await productsService.create({
        name: 'Premium Jacket',
        categoryId: category.id,
      });
      await createVariant(dataSource, premium, 'PREM', {
        price: 850_000,
        stock: 5,
      });

      // minPrice = 200_000 & maxPrice = 500_000 -> only Midrange Shirt
      const rangeResults = await productsService.findAll({
        minPrice: 200_000,
        maxPrice: 500_000,
      });
      expect(rangeResults.map((p) => p.name)).toEqual(['Midrange Shirt']);

      // maxPrice = 200_000 -> only Budget Shirt
      const lowResults = await productsService.findAll({ maxPrice: 200_000 });
      expect(lowResults.map((p) => p.name)).toEqual(['Budget Shirt']);

      // minPrice = 500_000 -> only Premium Jacket
      const highResults = await productsService.findAll({ minPrice: 500_000 });
      expect(highResults.map((p) => p.name)).toEqual(['Premium Jacket']);
    });
  });

  describe('Stock availability & inactive product/variant exclusion', () => {
    it('filters by inStock flag and excludes inactive variants and products', async () => {
      const category = await createCategory(dataSource, 'stock');

      const inStockProd = await productsService.create({
        name: 'In Stock Product',
        categoryId: category.id,
      });
      await createVariant(dataSource, inStockProd, 'STOCK-ON', {
        stock: 5,
        price: 200_000,
      });

      const oosProd = await productsService.create({
        name: 'OOS Product',
        categoryId: category.id,
      });
      await createVariant(dataSource, oosProd, 'STOCK-OFF', {
        stock: 0,
        price: 200_000,
      });

      const inactiveVariantProd = await productsService.create({
        name: 'Inactive Variant Product',
        categoryId: category.id,
      });
      await createVariant(dataSource, inactiveVariantProd, 'INACTIVE-VAR', {
        stock: 100,
        price: 200_000,
        isActive: false,
      });

      const inactiveProd = await productsService.create({
        name: 'Inactive Product',
        categoryId: category.id,
        status: ProductStatus.INACTIVE,
      });
      await createVariant(dataSource, inactiveProd, 'INACTIVE-PARENT', {
        stock: 100,
        price: 200_000,
      });

      // All active products (both in-stock and OOS)
      const all = await productsService.findAll({});
      expect(all.map((p) => p.name).sort()).toEqual(
        ['In Stock Product', 'Inactive Variant Product', 'OOS Product'].sort(),
      );

      // inStock = true -> only In Stock Product
      const inStockOnly = await productsService.findAll({ inStock: true });
      expect(inStockOnly.map((p) => p.name)).toEqual(['In Stock Product']);
    });
  });

  describe('Sorting semantics', () => {
    it('uses MIN(active variant price) for BOTH price_asc and price_desc with NULLS LAST', async () => {
      const category = await createCategory(dataSource, 'sorting');

      // Product A: min active price 300,000, max active price 700,000
      const pA = await productsService.create({
        name: 'Alpha Shirt',
        categoryId: category.id,
      });
      await createVariant(dataSource, pA, 'SORT-A1', {
        price: 300_000,
        stock: 5,
      });
      await createVariant(dataSource, pA, 'SORT-A2', {
        price: 700_000,
        stock: 5,
      });

      // Product B: min active price 100,000, max active price 400,000
      const pB = await productsService.create({
        name: 'Beta Shirt',
        categoryId: category.id,
      });
      await createVariant(dataSource, pB, 'SORT-B1', {
        price: 100_000,
        stock: 5,
      });
      await createVariant(dataSource, pB, 'SORT-B2', {
        price: 400_000,
        stock: 5,
      });

      // Product C: min active price 500,000
      const pC = await productsService.create({
        name: 'Gamma Shirt',
        categoryId: category.id,
      });
      await createVariant(dataSource, pC, 'SORT-C1', {
        price: 500_000,
        stock: 5,
      });

      // Product D: NO active variants (only inactive variant)
      const pD = await productsService.create({
        name: 'Delta Shirt No Price',
        categoryId: category.id,
      });
      await createVariant(dataSource, pD, 'SORT-D1', {
        price: 50_000,
        stock: 5,
        isActive: false,
      });

      // price_asc: Beta (100k), Alpha (300k), Gamma (500k), Delta (null price LAST)
      const priceAsc = await productsService.findAll({
        sort: ProductSort.PRICE_ASC,
      });
      expect(priceAsc.map((p) => p.name)).toEqual([
        'Beta Shirt',
        'Alpha Shirt',
        'Gamma Shirt',
        'Delta Shirt No Price',
      ]);

      // price_desc: Gamma (500k), Alpha (300k), Beta (100k), Delta (null price LAST)
      const priceDesc = await productsService.findAll({
        sort: ProductSort.PRICE_DESC,
      });
      expect(priceDesc.map((p) => p.name)).toEqual([
        'Gamma Shirt',
        'Alpha Shirt',
        'Beta Shirt',
        'Delta Shirt No Price',
      ]);

      // name_asc: Alpha, Beta, Delta, Gamma
      const nameAsc = await productsService.findAll({
        sort: ProductSort.NAME_ASC,
      });
      expect(nameAsc.map((p) => p.name)).toEqual([
        'Alpha Shirt',
        'Beta Shirt',
        'Delta Shirt No Price',
        'Gamma Shirt',
      ]);

      // name_desc: Gamma, Delta, Beta, Alpha
      const nameDesc = await productsService.findAll({
        sort: ProductSort.NAME_DESC,
      });
      expect(nameDesc.map((p) => p.name)).toEqual([
        'Gamma Shirt',
        'Delta Shirt No Price',
        'Beta Shirt',
        'Alpha Shirt',
      ]);

      // featured / default: same deterministic ordering as name_asc (Alpha, Beta, Delta, Gamma)
      const featured = await productsService.findAll({
        sort: ProductSort.FEATURED,
      });
      expect(featured.map((p) => p.name)).toEqual([
        'Alpha Shirt',
        'Beta Shirt',
        'Delta Shirt No Price',
        'Gamma Shirt',
      ]);
    });
  });

  describe('Facet options discovery (GET /products/filters)', () => {
    it('excludes inactive product categories/brands and formats sizes and prices correctly', async () => {
      // Active category & brand
      const activeCat = await createCategory(dataSource, 'fashion-active');
      const activeBrand = await dataSource.getRepository(Brand).save({
        name: 'Active Fashion Brand',
        slug: 'active-fashion-brand',
      });

      // Legacy inactive category & brand (e.g. Phase 3B electronics)
      const legacyCat = await createCategory(dataSource, 'legacy-electronics');
      const legacyBrand = await dataSource.getRepository(Brand).save({
        name: 'Legacy Electronics Brand',
        slug: 'legacy-electronics-brand',
      });

      // Unrelated empty category & brand with no products
      await createCategory(dataSource, 'empty-category');
      await dataSource.getRepository(Brand).save({
        name: 'Empty Brand',
        slug: 'empty-brand',
      });

      // Active Product under active category & brand
      const activeProd = await productsService.create({
        name: 'Active Fashion Item',
        categoryId: activeCat.id,
        brandId: activeBrand.id,
      });
      await createVariant(dataSource, activeProd, 'ACT-1', {
        attributes: { size: 'XL', color: 'Onyx Black' },
        price: 250_000,
        stock: 5,
      });
      await createVariant(dataSource, activeProd, 'ACT-2', {
        attributes: { size: 'S', color: 'Sage Green' },
        price: 150_000,
        stock: 5,
      });
      await createVariant(dataSource, activeProd, 'ACT-3', {
        attributes: { size: '2XL', color: 'Onyx Black' },
        price: 450_000,
        stock: 5,
      });
      await createVariant(dataSource, activeProd, 'ACT-4', {
        attributes: { size: 'XXL', color: 'White' },
        price: 350_000,
        stock: 5,
      });
      await createVariant(dataSource, activeProd, 'ACT-5', {
        attributes: { size: '32', color: 'Indigo' },
        price: 500_000,
        stock: 5,
      });
      await createVariant(dataSource, activeProd, 'ACT-6', {
        attributes: { size: 'One Size', color: 'Charcoal' },
        price: 200_000,
        stock: 5,
      });

      // Inactive Product under legacy category & brand
      const inactiveProd = await productsService.create({
        name: 'Legacy Electronics Device',
        categoryId: legacyCat.id,
        brandId: legacyBrand.id,
        status: ProductStatus.INACTIVE,
      });
      await createVariant(dataSource, inactiveProd, 'LEGACY-1', {
        attributes: { size: '15-inch', color: 'Space Grey' },
        price: 25_000_000,
        stock: 10,
      });

      const facets = await productsService.getFilterOptions();

      // Categories: MUST include activeCat, MUST NOT include legacyCat or empty-category
      const categorySlugs = facets.categories.map((c) => c.slug);
      expect(categorySlugs).toContain('category-fashion-active');
      expect(categorySlugs).not.toContain('category-legacy-electronics');
      expect(categorySlugs).not.toContain('category-empty-category');

      // Brands: MUST include activeBrand, MUST NOT include legacyBrand or empty-brand
      const brandSlugs = facets.brands.map((b) => b.slug);
      expect(brandSlugs).toContain('active-fashion-brand');
      expect(brandSlugs).not.toContain('legacy-electronics-brand');
      expect(brandSlugs).not.toContain('empty-brand');

      // Sizes: S, XL, 2XL, XXL (tie-broken deterministically), 32, One Size
      expect(facets.sizes).toEqual(['S', 'XL', '2XL', 'XXL', '32', 'One Size']);

      // Colors: deduplicated and sorted
      expect(facets.colors).toEqual([
        'Charcoal',
        'Indigo',
        'Onyx Black',
        'Sage Green',
        'White',
      ]);

      // Price bounds only from active variants of active products
      expect(facets.minPrice).toBe(150_000);
      expect(facets.maxPrice).toBe(500_000);
    });
  });
});
