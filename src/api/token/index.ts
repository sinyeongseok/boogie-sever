import express, { Request, Response, NextFunction } from 'express';
import { Knex } from 'knex';
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

import { verifyRefreshToken, generatedJwtToken } from '../../token/index';

app.post(
  '/refreshToken',
  verifyRefreshToken,
  async (req: Request, res: Response) => {
    const email = res.locals.email;
    try {
      const { id, nickname, is_admin } = await knex('user')
        .select('id', 'nickname', 'is_admin')
        .where({ id: email })
        .first();

      if (!id) {
        Promise.reject();
      }

      const accessToken = generatedJwtToken({
        email,
        sub: 'access',
        expiresIn: '5m',
      });

      res.status(200).json({
        data: {
          accessToken,
          nickname,
          email: id,
          isAdmin: is_admin,
        },
      });
    } catch (error) {
      return res.status(404).json({ message: '가입되지 않은 회원입니다.' });
    }
  }
);

export default app;
