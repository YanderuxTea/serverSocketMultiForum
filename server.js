import { configDotenv } from "dotenv";
import { createServer } from "http";
import { join } from "path";
import { Server } from "socket.io";
import { __dirname } from "./__dirname.js";
import { prisma } from "./lib/prisma.ts";
import { parseCookie } from "cookie";
import { validateJWT } from "./lib/jwt.ts";
let listOnline = [];
//настройка конфига и сервера
configDotenv({ path: join(__dirname, ".env") });
const server = createServer();
const io = new Server(server, {
  cors: {
    origin: process.env.NEXT_URL,
    credentials: true,
  },
});
//прослойка
io.use(async (socket, next) => {
  try {
    const headersCookie = socket.handshake.headers.cookie;
    const cookies = parseCookie(headersCookie);
    const token = cookies.token;
    const validToken = validateJWT(token);
    if (validToken) {
      socket.userData = validToken;
    } else {
      socket.userData = {
        id: socket.id,
        login: "Гость",
        role: "User",
      };
    }
  } catch {
    socket.userData = {
      id: socket.id,
      login: "Гость",
      role: "User",
    };
  }
  next();
});
//основное
io.on("connection", async (socket) => {
  const user = socket.userData;
  const sId = socket.id;
  console.log(`User ${user.login} connected`);
  listOnline.push({
    sId: sId,
    id: user.id,
    login: user.login,
    role: user.role,
  });

  const countUserConnection = listOnline.filter(
    (val) => val.id === user.id,
  ).length;
  const uniqueOnlineList = Array.from(
    new Map(listOnline.map((val) => [val.id, val])).values(),
  );
  socket.emit("init_user_list", uniqueOnlineList);
  if (countUserConnection === 1) {
    socket.broadcast.emit("new_user_connect", {
      sId: sId,
      id: user.id,
      login: user.login,
      role: user.role,
    });
    if (user.id !== sId) {
      await prisma.users.update({
        where: { id: user.id },
        data: { isOnline: true },
      });
    }
  }
  socket.on("disconnect", async () => {
    listOnline = listOnline.filter((val) => val.sId !== sId);
    if (user.id !== sId) {
      setTimeout(async () => {
        const isOnline = listOnline.some((val) => val.id === user.id);
        if (!isOnline) {
          io.emit("user_disconnect", user.id);
          await prisma.users.update({
            where: { id: user.id },
            data: { isOnline: false, lastSeen: new Date() },
          });
          console.log(`User ${user.login} disconnected`);
        }
      }, 3000);
    } else {
      console.log(`User ${user.login} disconnected`);
      io.emit("user_disconnect", user.id);
    }
  });
});
// включение сервера
server.listen(process.env.PORT, async () => {
  console.log(`Server running on ${process.env.PORT}`);
  await prisma.users.updateMany({ data: { isOnline: false } });
});
