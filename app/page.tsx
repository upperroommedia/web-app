/**
 * Website's home page
 */
import type { NextPage } from 'next';
import { Metadata } from 'next';
import { Welcome } from './Welcome';

export const metadata: Metadata = {
  title: 'Upper Room Media',
  description: 'Upper Room Media',
  // openGraph: {
  //   type: 'website',
  //   locale: 'en_IE',
  //   url: 'https://www.upperroommedia.org/',
  //   title: 'Upper Room Media',
  //   description: 'Upper Room Media',
  //   images: [
  //     {
  //       url: 'https://www.upperroommedia.org/images/URM_logo.png',
  //       width: 800,
  //       height: 600,
  //       alt: 'Upper Room Media Logo',
  //     },
  //   ],
  // },
};
const Home: NextPage = () => {
  return <Welcome />;
};

export default Home;
