import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { verifyAccessToken, getUserEmail } from '../../token';
import multer, { memoryStorage } from 'multer';
import { Knex } from 'knex';
import s3Controller from '../../s3/index';
import sharp from 'sharp';
dotenv.config();

const app: express.Application = express();
const knex: Knex = require('knex')({
  client: 'mysql',
  connection: {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
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

interface ProfileOptions {
  image?: string;
  positions?: { id: number; name: string }[];
  technologies?: number[];
  introduction?: string;
  awards?: { name: string; awarededAt: string }[];
  links?: string[];
}

interface Profile extends ProfileOptions {
  id: string;
  isMe: boolean;
  nickname: string;
  isOpen: boolean;
}

const getProfileInfo = async (id: string, requester: string = id) => {
  const isMe = id === requester;

  try {
    const profile: {
      isOpen: boolean;
      nickname: string;
      userId: string;
      image: string;
      positions: string;
      introduction: string;
      technologies: string;
      awards: string;
      links: string;
    } = await knex('user_profile')
      .select(
        'is_open_information as isOpen',
        'nickname',
        'user_id as userId',
        'image',
        'positions',
        'technologies',
        'introduction',
        'awards',
        'links'
      )
      .where({ user_id: id })
      .innerJoin('user', 'user_profile.user_id', 'user.id')
      .first();

    if (!profile) {
      return null;
    }

    const {
      isOpen,
      nickname,
      userId,
      image,
      introduction,
      positions,
      technologies,
      awards,
      links,
    } = profile;

    const baseInfo: Profile = {
      isOpen,
      isMe,
      nickname,
      id: userId,
    };

    if (!isMe && !isOpen) {
      return baseInfo;
    }

    const optionalInfo: ProfileOptions = {
      ...(!!awards && { awards: JSON.parse(awards) }),
      ...(!!links && { links: JSON.parse(links) }),
      ...(!!introduction && { introduction }),
    };

    if (!!positions) {
      const positionIds: number[] = JSON.parse(positions);
      const positionsInfo = await knex('job_category')
        .select('*')
        .whereIn('id', positionIds);
      optionalInfo.positions = positionsInfo;
    }

    if (!!technologies) {
      const technologyIds: number[] = JSON.parse(technologies);
      const technologiesInfo = await knex('technology')
        .select('*')
        .whereIn('id', technologyIds);
      optionalInfo.technologies = technologiesInfo;
    }

    if (!!image) {
      const imageURL = await s3Controller.getObjectURL(image);

      if (!!imageURL) {
        optionalInfo.image = imageURL;
      }
    }
    const profileScore = calculateProfileScore(optionalInfo);

    const profileInfo: Profile = { ...baseInfo, ...optionalInfo };
    return { profileInfo, profileScore };
  } catch (error) {
    throw new Error('프로필 가져오기 실패');
  }
};

const calculateProfileScore = (optionalInfo: ProfileOptions) => {
  const introductionScore = () => {
    let score = 0;

    if (!!optionalInfo.introduction?.length) {
      if (optionalInfo.introduction.length >= 100) score++;
      if (optionalInfo.introduction.length >= 200) score++;
      if (optionalInfo.introduction.length >= 300) score = score + 2;
    }
    return score;
  };

  const technologyScore = () => {
    let score = 0;

    if (!!optionalInfo.technologies?.length) {
      score++;
      if (optionalInfo.technologies?.length >= 2) score++;
      if (optionalInfo.technologies?.length >= 5) score = score + 2;
    }

    return score;
  };

  const positionScore = optionalInfo.positions?.length ? 1 : 0;
  const awardsScore = !optionalInfo.awards?.length
    ? 0
    : optionalInfo.awards.length >= 2
    ? 2
    : 1;
  const linksScore = !optionalInfo.links?.length
    ? 0
    : optionalInfo.links.length >= 2
    ? 2
    : 1;

  const rawScore =
    technologyScore() +
    introductionScore() +
    positionScore +
    awardsScore +
    linksScore;

  const profileScore = Math.round((rawScore / 13) * 100);
  return profileScore;
};

app.put(
  '/',
  verifyAccessToken,
  multer({ storage: memoryStorage() }).single('image'),
  async (req: Request, res: Response) => {
    const id: string = res.locals.email;
    const body: { [keys: string]: string } = JSON.parse(
      JSON.stringify(req.body)
    );
    const { positions, technologies, introduction, awards, links } = body;
    const image: Buffer | string | null =
      req.file?.buffer || req.body?.image || null;

    const profileUpdateBody = Object.entries({
      positions,
      technologies,
      introduction,
      awards,
      links,
    }).reduce((profileUpdateBody, [key, value]) => {
      profileUpdateBody[key] = value || null;
      return profileUpdateBody;
    }, {} as { [keys: string]: string | null });

    if (!!awards) {
      const parsedAwards: { name: string; awardedAt: string }[] =
        JSON.parse(awards);

      parsedAwards.sort((a, b) => {
        return a.awardedAt.localeCompare(b.awardedAt);
      });

      profileUpdateBody.awards = JSON.stringify(parsedAwards);
    }

    if (typeof image !== 'string') {
      try {
        const oldInfo: { image: string } = await knex('user_profile')
          .select('image')
          .where({ user_id: id })
          .first();

        if (!!oldInfo.image) {
          await s3Controller.deleteObject(oldInfo.image);
        }

        profileUpdateBody.image = null;
      } catch (error) {}

      if (image instanceof Buffer) {
        try {
          const resizedImageBuffer = await sharp(image)
            .resize({ fit: 'fill', width: 110, height: 110 })
            .toBuffer();
          const data = await s3Controller.uploadFile(
            resizedImageBuffer,
            `profile/${id}/${req.file?.originalname}`
          );
          profileUpdateBody.image = data.Key;
        } catch (error) {
          return res
            .status(500)
            .json({ message: '이미지 업로드에 실패하였습니다.' });
        }
      }
    }

    try {
      await knex('user_profile')
        .where({ user_id: id })
        .update(profileUpdateBody);

      const profileInfo = await getProfileInfo(id);

      res.status(200).json(profileInfo);
    } catch (error) {
      res.status(500).json({ message: '서버요청 실패' });
    }
  }
);

app.patch('/open', verifyAccessToken, async (req: Request, res: Response) => {
  const id: string = res.locals.email;
  const willOpenInformation: boolean = req.body.willOpenInformation;

  try {
    await knex('user_profile')
      .update({ is_open_information: willOpenInformation })
      .where({ user_id: id });
    res.status(200).json({ isOpen: willOpenInformation });
  } catch (error) {
    res.status(500).json({ message: '서버요청 실패' });
  }
});

app.get('/', getUserEmail, async (req: Request, res: Response) => {
  const requester: string = res.locals.email || '';
  const id = req.query?.id;

  if (!id) {
    return res.status(400).json({ message: '잘못된 요청입니다.' });
  }

  try {
    const profileInfo = await getProfileInfo(id as string, requester);

    if (!profileInfo) {
      return res.status(404).json({ message: '리소스를 찾을 수 없습니다.' });
    }

    res.status(200).json(profileInfo);
  } catch (error) {
    res.status(500).json({ message: '서버 요청에 실패하였습니다.' });
  }
});

export default app;
