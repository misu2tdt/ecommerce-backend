import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CollectionProduct } from './collection-product.entity';

// A curated, ordered group of products ("Everyday Essentials"). The members and
// their order live in collection_products.
@Entity('collections')
@Index('UQ_collections_slug', ['slug'], { unique: true })
@Index('IDX_collections_active_sort', ['isActive', 'sortOrder'])
export class Collection {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  slug!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  heroImageUrl!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false })
  isFeatured!: boolean;

  // Lower values come first in the public list; ties are broken by id.
  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @OneToMany(() => CollectionProduct, (member) => member.collection)
  members?: CollectionProduct[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
