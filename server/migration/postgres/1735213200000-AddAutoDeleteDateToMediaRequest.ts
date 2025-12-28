import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutoDeleteDateToMediaRequest1735213200000
  implements MigrationInterface
{
  name = 'AddAutoDeleteDateToMediaRequest1735213200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add autoDeleteDate column to media_request table
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "autoDeleteDate" TIMESTAMP`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove autoDeleteDate column
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "autoDeleteDate"`
    );
  }
}

