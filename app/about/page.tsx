/**
 * About page for information about Upper Room Media
 */
import type { Metadata, NextPage } from 'next';

export const metadata: Metadata = {
  title: 'About',
  description:
    'Bringing the Word of God from a timeless faith into your hearts and minds anytime, anywhere. Upper Room Media is a ministry of the Coptic Orthodox Church that brings to you rich & fresh spiritual resources including Sermons, Music, Videos, Blogs and much more!',
};

const About: NextPage = () => {
  return (
    <div className="flex justify-center">
      <h1 className="text-4xl">About</h1>
    </div>
  );
};

export default About;
