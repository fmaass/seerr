import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutoDeleteDaysToMediaRequest1739500800000
  implements MigrationInterface
{
  name = 'AddAutoDeleteDaysToMediaRequest1739500800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "autoDeleteDays" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "autoDeleteDays"`
    );
  }
}
