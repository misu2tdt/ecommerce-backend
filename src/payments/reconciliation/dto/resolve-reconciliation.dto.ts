import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResolveReconciliationDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'Refunded manually in the MoMo merchant portal',
    description:
      'What the admin did about this event (3-500 characters after trimming).',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;
}
