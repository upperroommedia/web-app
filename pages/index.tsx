/**
 * Uploader Page - Main entry point for uploading sermons
 * Uses the AdminSidebarLayout for consistent navigation
 */
import type { NextPage } from 'next';
import Head from 'next/head';
import VerifiedUserUploader from '../components/uploaderComponents/VerifiedUserUploaderComponent';
import AdminLayout from '../layout/adminLayout';

const Home: NextPage & { PageLayout?: React.ComponentType<{ children: React.ReactNode }> } = () => {
  return (
    <>
      <Head>
        <title>Upload Sermon | Upper Room Media</title>
        <meta property="og:title" content="Upload Sermon | Upper Room Media" key="title" />
        <meta name="description" content="Upload sermons to Upper Room Media" />
      </Head>
      <VerifiedUserUploader />
    </>
  );
};

// Use AdminLayout for the sidebar navigation
Home.PageLayout = AdminLayout;

export default Home;
