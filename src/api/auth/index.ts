import express, { Request, Response, NextFunction } from 'express';
import { Knex } from 'knex';
import crypto from 'crypto';
import { generatedJwtToken } from '../../token/index';
import { checkObjectValueEmpty, verifyEmail } from '../../utils';
import s3Controller from '../../s3/index';
import dayjs from 'dayjs';
import sendMail from '../../mail/index';
import dotenv from 'dotenv';
dotenv.config();

const app: express.Application = express();

const knex: Knex = require('knex')({
  client: 'mysql',
  connection: {
    host: process.env.DB_HOST,
    port: 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    typeCast: (field: any, next: NextFunction) => {
      if (field.type === 'TINY' && field.length === 4) {
        let value = field.string();

        return value ? value === '1' : null;
      }

      return next();
    },
  },
});

const createCode = (length: number): string => {
  let code = '';
  const character =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (let i: number = 0; i < length; i++) {
    code += character.charAt(Math.floor(Math.random() * character.length));
  }

  return code;
};

const getCurrentDate = (): string => {
  return dayjs().format('YYYY-MM-DD HH:mm:ss');
};

app.post('/code/email', (req: Request, res: Response) => {
  const { id }: { id: string } = req.body;

  if (!checkObjectValueEmpty({ id })) {
    return res.status(400).json({ message: '잘못된 요청입니다.' });
  }

  if (!verifyEmail(id)) {
    return res.status(403).json({ message: '아이디가 형식에 맞지않습니다.' });
  }

  const authCode: string = createCode(8);
  const currentDate: string = getCurrentDate();
  const mailOptions = {
    toEmail: id,
    title: '이메일 인증',
    content: `<p> 이메일 인증번호는 ${authCode} 입니다. </p>`,
  };

  knex('auth')
    .delete()
    .where({ email: id, is_auth: 0 })
    .then((ignore) => {
      return Promise.all([
        sendMail(mailOptions),
        knex('auth').insert({
          email: id,
          auth_code: authCode,
          date: currentDate,
        }),
      ]);
    })
    .then((ignore) => {
      res.status(201).json({ isSend: true });
    })
    .catch((err) => {
      res.status(500).json({ message: '서버요청에 실패하였습니다.' });
    });
});

const checkValidAuthDate = (authDate: string, currentDate: string): boolean => {
  return dayjs(authDate).diff(currentDate, 'm') > -5;
};

app.post('/email', (req: Request, res: Response) => {
  const { id, code }: { id: string; code: string } = req.body;

  if (!checkObjectValueEmpty({ id, code })) {
    return res.status(400).json({ message: '잘못된 요청입니다.' });
  }

  const currentDate: string = getCurrentDate();

  knex('auth')
    .select('date')
    .where({ email: id, auth_code: code, is_auth: 0 })
    .first()
    .then((authInfo: { date: string }) => {
      if (!authInfo) {
        return Promise.reject({
          code: 409,
          message: '인증번호가 틀렸습니다.',
        });
      }

      if (!checkValidAuthDate(authInfo.date, currentDate)) {
        return Promise.reject({
          code: 409,
          message: '인증요청 시간이 만료되었습니다.',
        });
      }

      return knex('auth')
        .update({
          is_auth: 1,
          date: currentDate,
        })
        .where({
          email: id,
          auth_code: code,
        });
    })
    .then((ignore) => {
      res.status(200).json({ isAuth: true });
    })
    .catch((err) => {
      if (isNaN(err.code)) {
        return res.status(500).json({ message: '서버요청에 실패하였습니다.' });
      }
      res.status(err.code).json({ message: err.message });
    });
});

const encryptString = (str: string = ''): string => {
  return crypto.createHash('sha256').update(str).digest('base64');
};

app.post('/login', (req: Request, res: Response) => {
  const { id, password }: { id: string; password: string } = req.body;

  if (!checkObjectValueEmpty({ id, password })) {
    return res.status(400).json({ message: '잘못된 요청입니다.' });
  }

  knex('user')
    .select(
      'user.nickname as nickname',
      'user.is_admin as isAdmin',
      'user_profile.image as profileImageKey'
    )
    .leftJoin('user_profile', 'user.id', 'user_profile.user_id')
    .where({ id, password: encryptString(password) })
    .first()
    .then(
      async (user?: {
        nickname: string;
        isAdmin: string;
        profileImageKey: string | null;
      }) => {
        let profileImage: string | false = false;
        if (!user) {
          return Promise.reject({
            code: 400,
            message: '아이디 또는 비밀번호를 잘못 입력했습니다.',
          });
        }

        if (!!user?.profileImageKey) {
          profileImage = await s3Controller.getObjectURL(
            user?.profileImageKey as string
          );
        }

        const refreshToken = generatedJwtToken({
          email: id,
          sub: 'refresh',
          expiresIn: '24h',
        });
        const accessToken = generatedJwtToken({
          email: id,
          sub: 'access',
          expiresIn: '5m',
        });

        res.status(200).json({
          data: {
            refreshToken,
            accessToken,
            email: id,
            nickname: user.nickname,
            isAdmin: user.isAdmin,
            ...(!!profileImage && { profileImage }),
          },
        });
      }
    )
    .catch((err) => {
      console.log(err);
      if (isNaN(err.code)) {
        return res.status(500).json({ message: '서버요청에 실패하였습니다.' });
      }
      res.status(err.code).json({ message: err.message });
    });
});

const isVaildBirthday = (birthday: string = ''): boolean => {
  return dayjs(birthday, 'YYYYMMDD').format('YYYYMMDD') === birthday;
};

interface joinBody {
  id: string;
  nickname: string;
  password: string;
  verifyPassword: string;
}

app.post('/join', (req: Request, res: Response) => {
  const { id, nickname, password, verifyPassword }: joinBody = req.body;

  if (
    !checkObjectValueEmpty({
      id,
      nickname,
      password,
      verifyPassword,
    })
  ) {
    return res.status(400).json({ message: '잘못된 요청입니다.' });
  }

  if (password !== verifyPassword) {
    return res.status(400).json({ message: '비밀번호가 일치하지 않습니다.' });
  }

  knex('user')
    .select('id', 'nickname')
    .where({ id })
    .orWhere({ nickname })
    .first()
    .then((user) => {
      if (!!user) {
        if (user.id === id) {
          return Promise.reject({
            code: 409,
            message: '이미 존재하는 아이디(이메일) 입니다.',
          });
        }

        if (user.nickname === nickname) {
          return Promise.reject({
            code: 409,
            message: '이미 존재하는 닉네임 입니다.',
          });
        }
      }

      return Promise.resolve(
        knex('user').insert({
          id,
          nickname,
          password: encryptString(password),
        })
      );
    })
    .then((ignore) => {
      res.status(201).json({ isJoin: true });
    })
    .catch((err) => {
      if (isNaN(err.code)) {
        return res.status(500).json({ message: '서버요청에 실패하였습니다.' });
      }
      res.status(err.code).json({ message: err.message });
    });
});

export default app;
