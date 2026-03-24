import { NextApiRequest, NextApiResponse } from 'next';
import { List } from '../../types/List';
import { addNewList } from '../../utils/addNewList';

const addNewListHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const list = req.body as List | undefined;
  if (!list || !list.name) {
    return res.status(400).json({ error: 'Invalid list payload' });
  }

  try {
    const id = await addNewList(list);
    return res.status(200).json({ id });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create list' });
  }
};

export default addNewListHandler;
