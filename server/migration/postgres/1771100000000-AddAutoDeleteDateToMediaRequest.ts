import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutoDeleteDateToMediaRequest1771100000000
  implements MigrationInterface
{
  name = 'AddAutoDeleteDateToMediaRequest1771100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN IF NOT EXISTS "autoDeleteDate" TIMESTAMP`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN IF EXISTS "autoDeleteDate"`
    );
  }
}
