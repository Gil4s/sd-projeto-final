import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createHandler } from './app.mjs';

const region = process.env.AWS_REGION || 'us-east-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const handler = createHandler({
  ddb,
  config: {
    tableName: process.env.TABLE_NAME || 'sd-projeto-final-guilhermeag',
  },
});
