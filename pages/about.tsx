/**
 * About page for information about Upper Room Media
 */
import type { NextPage } from 'next';
import Head from 'next/head';
import styles from '../styles/Home.module.css';

const About: NextPage = () => {
  return (
    <>
      <Head>
        <title>About</title>
        <meta property="og:title" content="About" key="title" />
        <meta
          name="description"
          content="Bringing the Word of God from a timeless faith into your hearts and minds anytime, anywhere.
Upper Room Media is a ministry of the Coptic Orthodox Church that brings to you rich & fresh spiritual resources including Sermons, Music, Videos, Blogs and much more!"
          key="description"
        />
      </Head>
      <div className={styles.container}>
        <h1>About</h1>
      </div>
    </>
  );
};

export default About;
