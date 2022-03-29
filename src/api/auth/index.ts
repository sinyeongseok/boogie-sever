import express, { Request, Response, NextFunction } from 'express';
import { Knex } from 'knex';
import crypto from 'crypto';
import { generatedJwtToken } from '../../token/index';
import { checkObjectValueEmpty } from '../../utils';
import nodemailer from 'nodemailer';
import dayjs from 'dayjs';
import isLeapYear from 'dayjs/plugin/isLeapYear';
dayjs.extend(isLeapYear);
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

const sendMail = (toEmail: string = '', code: string = '') => {
  const mailConfig = {
    service: 'Naver',
    host: 'smtp.naver.com',
    port: 587,
    auth: {
      user: process.env.NODEMAILER_USER,
      pass: process.env.NODEMAILER_PASS,
    },
  };

  const message = {
    from: process.env.NODEMAILER_USER,
    to: toEmail,
    subject: '이메일 인증',
    html: `<p> 이메일 인증번호는 ${code} 입니다. </p>`,
  };

  const transporter = nodemailer.createTransport(mailConfig);

  return new Promise((resolve, reject) => {
    transporter.sendMail(message, (err, info) => {
      if (err) {
        reject();
      }
      resolve({ isSend: true });
    });
  });
};

const verifyEmail = (email: string = ''): boolean => {
  const regularEmail: RegExp =
    /^([0-9a-zA-Z_.-]+)@([0-9a-zA-Z_-]+)(\.[0-9a-zA-Z_-]+){1,3}$/;

  return regularEmail.test(email);
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

  knex('auth')
    .delete()
    .where({ email: id, is_auth: 0 })
    .then((ignore) => {
      return Promise.all([
        sendMail(id, authCode),
        knex('auth').insert({
          email: id,
          auth_code: authCode,
          date: currentDate,
        }),
      ]);
    })
    .then((ignore) => {
      res.status(201).json({ isAuth: true });
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

  if (!verifyEmail(id)) {
    return res.status(403).json({ message: '아이디가 형식에 맞지않습니다.' });
  }

  knex('user')
    .select('nickname', 'is_admin as isAdmin')
    .where({ id, password: encryptString(password) })
    .first()
    .then((user?: { nickname: string; isAdmin: string }) => {
      if (!user) {
        return Promise.reject({
          code: 400,
          message: '아이디 또는 비밀번호를 잘못 입력했습니다.',
        });
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
        },
      });
    })
    .catch((err) => {
      if (isNaN(err.code)) {
        return res.status(500).json({ message: '서버요청에 실패하였습니다.' });
      }
      res.status(err.code).json({ message: err.message });
    });
});

const isVaildBirthday = (birthday: string = ''): boolean => {
  const year: number = Number(birthday.substring(0, 4));
  const month: number = Number(birthday.substring(4, 6));
  const day: number = Number(birthday.substring(6, 8));
  const yearNow: number = Number(dayjs().format('YYYY'));

  if (birthday.length == 8) {
    if (1900 > year || year > yearNow) {
      return false;
    } else if (month < 1 || month > 12) {
      return false;
    } else if (day < 1 || day > 31) {
      return false;
    } else if (
      (month == 4 || month == 6 || month == 9 || month == 11) &&
      day == 31
    ) {
      return false;
    } else if (month == 2) {
      const isleap = dayjs(birthday).isLeapYear();
      if (day > 29 || (day == 29 && !isleap)) {
        return false;
      } else {
        return true;
      }
    } else {
      return true;
    }
  } else {
    return false;
  }
};

interface joinBody {
  id: string;
  nickname: string;
  password: string;
  verifyPassword: string;
  isStudent: boolean;
  uniID?: string;
  name?: string;
  birthday?: string;
}

app.post('/join', (req: Request, res: Response) => {
  const {
    id,
    nickname,
    password,
    verifyPassword,
    isStudent,
    uniID,
    name,
    birthday,
  }: joinBody = req.body;

  if (
    !checkObjectValueEmpty({
      id,
      nickname,
      password,
      verifyPassword,
      isStudent,
    })
  ) {
    return res.status(400).json({ message: '잘못된 요청입니다.' });
  }

  if (password !== verifyPassword) {
    return res.status(400).json({ message: '비밀번호가 일치하지 않습니다.' });
  }

  const promiseAllArray = [
    knex('user')
      .select('id', 'nickname')
      .where({ id })
      .orWhere({ nickname })
      .first(),
  ];

  if (isStudent) {
    if (!checkObjectValueEmpty({ uniID, name, birthday })) {
      return res.status(400).json({ message: '잘못된 요청입니다.' });
    }

    if (isVaildBirthday(birthday)) {
      return res.status(400).json({ message: '유효하지 않는 생년월일입니다.' });
    }

    promiseAllArray.push(
      knex('student')
        .select('name')
        .where({
          uni_id: uniID,
          name: name,
          birthday: birthday,
        })
        .first()
    );

    promiseAllArray.push(
      knex('user')
        .select('id')
        .where({
          uni_id: uniID,
          name: name,
          birthday: birthday,
        })
        .first()
    );
  }

  Promise.all(promiseAllArray)
    .then(([user, student, existingUser]) => {
      if (isStudent && !!existingUser) {
        return Promise.reject({
          code: 409,
          message: '이미 계정이 존재합니다.',
        });
      }

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

      if (isStudent && !student) {
        return Promise.reject({
          code: 403,
          message: '등록되어있지 않은 학생정보 입니다.',
        });
      }

      return knex('user').insert({
        id,
        nickname,
        name,
        birthday,
        uni_id: uniID,
        password: encryptString(password),
        is_student: isStudent ? 1 : 0,
      });
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