import { configDotenv } from "dotenv";
import { createServer } from "http";
import { join } from "path";
import { Server } from "socket.io";
import { __dirname } from "./__dirname.js";
import { prisma } from "./lib/prisma.ts";
import { validateJWT } from "./lib/jwt.ts";
import { generateChatIdRecentRoom } from "./generateChatIdRecentRoom.js";
import { uuidv7 } from "uuidv7";
import { encrypt } from "./encrypt.js";
let listOnline = [];
let listDeletingChat = [];
let listChatsTyping = [];
//настройка конфига и сервера
configDotenv({ path: join(__dirname, ".env") });
const server = createServer();
const io = new Server(server, {
  cors: {
    origin: process.env.NEXT_URL,
  },
});
//прослойка
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth;
    const validToken = validateJWT(token.token.value);
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
  socket.join(user.login);
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
  // Слушатель дисконнекта от сокета
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
  // Слушатель подключения к чату
  socket.on("connectToChat", async (data) => {
    const loginConnected = user.login;
    const loginRecipient = data.loginChat;
    const idRecentRoom = generateChatIdRecentRoom(
      loginConnected,
      loginRecipient,
    );
    if (data.chatId === "recent") {
      socket.join(idRecentRoom);
      console.log(
        `Пользователь ${user.login} подключился к комнате ${idRecentRoom}`,
      );
    } else {
      const checkPermission = await prisma.chats.findFirst({
        where: {
          id: data.chatId,
          Users: { some: { login: loginConnected } },
          AND: { Users: { some: { login: loginRecipient } } },
        },
      });
      if (!checkPermission) {
        socket.disconnect();
      } else {
        socket.join(data.chatId);
        console.log(
          `Пользователь ${user.login} подключился к комнате ${data.chatId}`,
        );
      }
    }
  });
  // Отключение от чата слушатель
  socket.on("disconnectFromChat", async (data) => {
    if (data.chatId === "recent") {
      const loginConnected = user.login;
      const loginRecipient = data.loginChat;
      const idRecentRoom = generateChatIdRecentRoom(
        loginConnected,
        loginRecipient,
      );
      socket.leave(idRecentRoom);
      console.log(
        `Пользователь ${user.login} отключился от комнаты ${idRecentRoom}`,
      );
    } else {
      socket.leave(data.chatId);
      console.log(
        `Пользователь ${user.login} отключился от комнаты ${data.chatId}`,
      );
    }
  });
  // Слушатель отправки сообщения
  socket.on("sendMessage", async (data) => {
    const loginSender = user.login;
    const loginRecipient = data.loginChat;
    if (data.text.trim().length > 2000) {
      socket.emit("errorSendMessage");
      return;
    }
    const encryptedMessage = encrypt(data.text);
    const chatId =
      data.chatId === "recent"
        ? generateChatIdRecentRoom(loginRecipient, loginSender)
        : data.chatId;
    const room = io.sockets.adapter.rooms.get(chatId);
    const uniqueLoginList = new Set();
    for (const sid of room) {
      const socket = io.sockets.sockets.get(sid);
      uniqueLoginList.add(socket.userData.login);
    }
    const isSoloInChat = uniqueLoginList.size === 1;
    if (data.chatId === "recent") {
      try {
        const newChat = await prisma.chats.create({
          data: {
            MessagesChats: {
              create: {
                text: encryptedMessage,
                authorId: user.id,
                isRead: !isSoloInChat,
              },
            },
            Users: {
              connect: [{ login: loginSender }, { login: loginRecipient }],
            },
            id: chatId,
          },
          select: {
            id: true,
            lastMessageTime: true,
            Users: {
              select: { login: true, role: true, avatar: true },
            },
            MessagesChats: {
              select: {
                id: true,
                text: true,
                createdAt: true,
                authorId: true,
                isRead: true,
              },
            },
            _count: { select: { MessagesChats: { where: { isRead: false } } } },
            idV7: true,
          },
        });
        io.to(chatId).emit("newChat", { id: newChat.id });
        io.to(chatId).emit("newMessage", {
          newMessage: newChat.MessagesChats[0],
        });

        io.to([loginRecipient, loginSender]).emit("createNewChat", {
          id: newChat.id,
          lastMessageTime: newChat.lastMessageTime,
          MessagesChats: newChat.MessagesChats,
          Users: newChat.Users,
          newIdV7: newChat.idV7,
          _count: newChat._count,
        });

        io.to([loginRecipient, loginSender]).emit("newMessageReceived", {
          newMessage: newChat.MessagesChats[0],
        });
      } catch {
        const newMessage = await prisma.messagesChats.create({
          data: {
            authorId: user.id,
            chatsId: chatId,
            text: encryptedMessage,
            isRead: !isSoloInChat,
          },
          select: {
            id: true,
            createdAt: true,
            text: true,
            authorId: true,
            isRead: true,
          },
        });
        const updateDateTime = await prisma.chats.update({
          where: { id: chatId },
          data: { lastMessageTime: new Date(), idV7: uuidv7() },
          select: { lastMessageTime: true, idV7: true },
        });

        io.to(chatId).emit("newMessage", {
          newMessage,
          newDate: updateDateTime.lastMessageTime,
          newIdV7: updateDateTime.idV7,
          chatId,
        });
        io.to([loginRecipient, loginSender]).emit("newMessageReceived", {
          newMessage,
          newDate: updateDateTime.lastMessageTime,
          newIdV7: updateDateTime.idV7,

          chatId,
        });
      }
    } else {
      const newMessage = await prisma.messagesChats.create({
        data: {
          authorId: user.id,
          chatsId: chatId,
          text: encryptedMessage,
          isRead: !isSoloInChat,
        },
        select: {
          id: true,
          createdAt: true,
          text: true,
          authorId: true,
          isRead: true,
        },
      });
      const updateDateTime = await prisma.chats.update({
        where: { id: chatId },
        data: { lastMessageTime: new Date(), idV7: uuidv7() },
        select: { lastMessageTime: true, idV7: true },
      });
      io.to(chatId).emit("newMessage", {
        newMessage,
        newDate: updateDateTime.lastMessageTime,
        newIdV7: updateDateTime.idV7,
        chatId,
      });

      io.to([loginRecipient, loginSender]).emit("newMessageReceived", {
        newMessage,
        newDate: updateDateTime.lastMessageTime,
        newIdV7: updateDateTime.idV7,
        chatId,
      });
    }

    if (isSoloInChat) {
      const newNotify = await prisma.notifications.create({
        data: {
          userLoginFrom: loginSender,
          userLoginTo: loginRecipient,
          type: "message",
          metaData: { loginSender: loginSender },
        },
      });
      io.to(loginRecipient).emit("newMessageNotify", {
        loginRecipient,
        metaData: newNotify.metaData,
        idNotify: newNotify.id,
        createdAt: newNotify.createdAt,
        typeNotify: newNotify.type,
      });
      io.to(loginRecipient).emit("newMessageUnread", { chatId });
    }
    socket.emit("successful");
    socket.to(loginRecipient).emit("userStopWriting", { login: loginSender });
    listChatsTyping = listChatsTyping.filter((val) => {
      return val.chatId !== chatId;
    });
  });
  // Эмит на реконнект
  if (socket.rooms.size >= 1) {
    socket.emit("reconnect", { listChatsTyping, userLogin: user.login });
  }
  // Закрытие темы
  socket.on("themeClose", async (data) => {
    const loginRecipient = data.login;
    const loginCloser = user.login;
    const themeId = data.themeId;
    const themeTitle = data.themeTitle;
    const roleCloser = data.roleCloser;
    const idSubCat = data.idSubCat;
    const newNotify = await prisma.notifications.create({
      data: {
        userLoginFrom: loginCloser,
        userLoginTo: loginRecipient,
        type: "close",
        metaData: { loginCloser, roleCloser, themeId, themeTitle, idSubCat },
      },
    });
    io.to(loginRecipient).emit("yourThemeClose", {
      loginRecipient,
      idNotify: newNotify.id,
      metaData: newNotify.metaData,
      typeNotify: newNotify.type,
      createdAt: newNotify.createdAt,
    });
  });
  // Ответ в тему
  socket.on("answerTheme", async (data) => {
    const loginRecipient = data.loginAuthor;
    const loginSender = data.login;
    if (loginSender === loginRecipient) {
      return;
    }
    const idSubCat = data.idSubCat;
    const roleSender = data.role;
    const themeId = data.themeId;
    const themeTitle = data.themeTitle;
    const newNotify = await prisma.notifications.create({
      data: {
        userLoginFrom: loginSender,
        userLoginTo: loginRecipient,
        type: "answer",
        metaData: { loginSender, roleSender, themeId, themeTitle, idSubCat },
      },
    });
    io.to(loginRecipient).emit("answerInYourTheme", {
      loginRecipient,
      idNotify: newNotify.id,
      typeNotify: newNotify.type,
      createdAt: newNotify.createdAt,
      metaData: newNotify.metaData,
    });
  });
  // Реакции
  socket.on("reaction", async (data) => {
    const loginSender = data.loginAuthor;
    const loginRecipient = data.loginRecipient;
    const reactionType = data.reactionType;
    const themeId = data.themeId;
    const roleSender = data.roleAuthor;
    const themeTitle = data.titleTheme;
    const idSubCat = data.idSubCat;
    const newNotify = await prisma.notifications.create({
      data: {
        userLoginFrom: loginSender,
        userLoginTo: loginRecipient,
        type: "reaction",
        metaData: {
          themeId,
          themeTitle,
          reactionType,
          roleSender,
          loginSender,
          idSubCat,
        },
      },
    });
    console.log(
      `Пользователь ${loginSender} отреагировал в ${newNotify.createdAt}`,
    );

    io.to(loginRecipient).emit("messageReacted", {
      loginRecipient,
      idNotify: newNotify.id,
      createdAt: newNotify.createdAt,
      typeNotify: newNotify.type,
      metaData: newNotify.metaData,
    });
  });
  // Повышение ранга
  socket.on("rank", async (data) => {
    const { login, rankLvl } = data;
    const newNotify = await prisma.notifications.create({
      data: {
        userLoginFrom: login,
        userLoginTo: login,
        type: "rank",
        metaData: { rankLvl },
      },
    });
    io.to(login).emit("upRank", {
      loginRecipient: login,
      idNotify: newNotify.id,
      createdAt: newNotify.createdAt,
      typeNotify: newNotify.type,
      metaData: newNotify.metaData,
    });
  });
  // Удаление чатов
  socket.on("deleteChat", async (data) => {
    const { id, login } = data;
    if (listDeletingChat.includes(id)) {
      socket.emit("processExecution");
      return;
    } else {
      listDeletingChat.push(id);
      try {
        await prisma.chats.delete({
          where: {
            Users: { some: { login: login } },
            AND: [{ Users: { some: { login: user.login } } }],
            id: id,
          },
        });
        io.to([user.login, login]).emit("successfulDeletingChat", {
          id,
        });
        console.log(`Пользователь ${user.login} удалил чат с ${login}`);
      } catch {
        socket.emit("errorDeletingChat");
        console.log(`Произошла ошибка при удалении чата ${id}`);
      } finally {
        listDeletingChat = listDeletingChat.filter((val) => val !== id);
      }
    }
  });
  // Статус печатает
  socket.on("writing", async (data) => {
    listChatsTyping = Array.from(
      new Set([
        ...listChatsTyping,
        { chatId: data.chatId, typingUser: user.login },
      ]),
    );
    socket.to(data.loginChat).emit("userWriting", { login: user.login });
  });
  // Снятие статуса печатает
  socket.on("stopWriting", async (data) => {
    listChatsTyping = listChatsTyping.filter((val) => {
      return val.chatId !== data.chatId;
    });
    socket.to(data.loginChat).emit("userStopWriting", { login: user.login });
  });
  // Открытие центра уведомлений
  socket.on("openNotifyCenter", async () => {
    io.to(user.login).emit("openNotifyCenterRes");
  });
  // Очистка центра уведомлений
  socket.on("clearNotifyCenter", async () => {
    await prisma.notifications.deleteMany({
      where: { userLoginTo: user.login },
    });
    setTimeout(() => {
      io.to(user.login).emit("clearedNotifyCenter", { login: user.login });
    }, 200);
  });
  // Прочитали чат
  socket.on("readChat", async (data) => {
    const { chatId, loginChat } = data;
    const loginUser = user.login;
    const idUser = user.id;
    await prisma.messagesChats.updateMany({
      where: { chatsId: chatId, authorId: { not: idUser }, isRead: false },
      data: { isRead: true },
    });
    io.to([loginChat, loginUser]).emit("chatIsRead", { chatId });
  });
});

// включение сервера
server.listen(process.env.PORT, async () => {
  console.log(`Server running on ${process.env.PORT}`);
  await prisma.users.updateMany({ data: { isOnline: false } });
});
