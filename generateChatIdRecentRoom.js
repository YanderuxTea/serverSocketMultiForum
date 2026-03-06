export function generateChatIdRecentRoom(login1, login2) {
  return [login1, login2].sort().join("_");
}
