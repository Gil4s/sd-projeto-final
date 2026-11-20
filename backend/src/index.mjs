import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHandler } from './app.mjs';

const region = process.env.AWS_REGION || 'us-east-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region });

export const handler = createHandler({
  ddb,
  s3,
  getSignedUrl,
  config: {
    tableName: process.env.TABLE_NAME || 'sd-projeto-final-guilhermeag',
    bucketName: process.env.BUCKET_NAME || 'sd-projeto-final-anexos-guilhermeag-737116127842',
  },
});
