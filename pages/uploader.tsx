/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import type { NextPage } from "next";
import Footer from "../components/Footer";
import Navbar from "../components/Navbar";
import styles from "../styles/Home.module.css";

const Uploader: NextPage = () => {
  return (
    <div className={styles.container}>
      <Navbar />
      <h1>Uploader</h1>
      <Footer />
    </div>
  );
};

export default Uploader;
