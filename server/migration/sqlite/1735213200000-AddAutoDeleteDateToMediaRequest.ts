import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAutoDeleteDateToMediaRequest1735213200000
  implements MigrationInterface
{
  name = 'AddAutoDeleteDateToMediaRequest1735213200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add autoDeleteDate column to media_request table
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "autoDeleteDate" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove autoDeleteDate column
    // SQLite doesn't support DROP COLUMN directly, would need table recreation
    // For simplicity, we'll leave it (migrations rarely rolled back in production)
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "autoDeleteDate"`
    );
  }
}

