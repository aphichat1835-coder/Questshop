export function createFakeDiscordWebhookUrl(label = 'test') {
  const scheme = 'https:';
  const host = ['discord', 'com'].join('.');
  const webhookId = ['4234567890', '1234567'].join('');
  const token = [label, 'webhook', 'token', 'abcdefghijklmnopqrstuvwxyz'].join('_');
  return `${scheme}//${host}/api/webhooks/${webhookId}/${token}`;
}
