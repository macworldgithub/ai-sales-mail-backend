const { fail } = require('./http');
function parseChunks(body) {
  if (body.chunkSize === undefined || body.chunkSize === null) return { chunkSize: null, chunkGapSeconds: null };
  if (!Number.isInteger(body.chunkSize) || body.chunkSize < 1 || body.chunkSize > 1000) fail(400, 'Chunk size must be a whole number between 1 and 1000');
  if (!Number.isInteger(body.chunkGapSeconds) || body.chunkGapSeconds < 1 || body.chunkGapSeconds > 604800) fail(400, 'Gap between chunks must be between 1 second and 7 days');
  return { chunkSize: body.chunkSize, chunkGapSeconds: body.chunkGapSeconds };
}
function chunkReady(campaign, now = new Date()) {
  return !campaign.chunkSize || !campaign.nextChunkAt || new Date(campaign.nextChunkAt) <= now;
}
function inCurrentChunk(campaign, index) {
  if (!campaign.chunkSize) return true;
  const start = (campaign.currentChunk || 0) * campaign.chunkSize;
  return index >= start && index < start + campaign.chunkSize;
}
const retryable = recipient => ['pending', 'failed'].includes(recipient.deliveryStatus) && (recipient.initialAttempts || 0) < 3;
function nextChunkUpdate(campaign, now = new Date()) {
  if (!campaign.chunkSize || !chunkReady(campaign, now)) return {};
  const start = (campaign.currentChunk || 0) * campaign.chunkSize;
  const end = start + campaign.chunkSize;
  if (end >= campaign.recipients.length || campaign.recipients.slice(start, end).some(retryable)) return {};
  return { currentChunk: (campaign.currentChunk || 0) + 1, nextChunkAt: new Date(now.getTime() + campaign.chunkGapSeconds * 1000) };
}
module.exports = { parseChunks, chunkReady, inCurrentChunk, retryable, nextChunkUpdate };
