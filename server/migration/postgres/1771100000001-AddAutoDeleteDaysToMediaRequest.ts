import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutoDeleteDaysToMediaRequest1771100000001
  implements MigrationInterface
{
  name = 'AddAutoDeleteDaysToMediaRequest1771100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN IF NOT EXISTS "autoDeleteDays" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN IF EXISTS "autoDeleteDays"`
    );
  }
}
