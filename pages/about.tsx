/**
 * About page for information about Upper Room Media
 */
 import type { NextPage } from 'next'
import Footer from "../components/Footer";
import Navbar from "../components/Navbar";
import styles from "../styles/Home.module.css";

const About: NextPage = () => {
  return (
    <div className={styles.container}>
      <Navbar />
      <h1>About</h1>
      <Footer />
    </div>
  );
}

export default About;
