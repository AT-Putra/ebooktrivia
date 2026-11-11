export interface PlayQuestion {
  text: string;
  options: string[];
  /** Index into options. */
  answer: number;
  explanation: string;
}

export const QUESTION_SECONDS = 20;

export const QUESTIONS: PlayQuestion[] = [
  {
    text: "Candi Buddha terbesar di dunia yang terletak di Magelang, Jawa Tengah, bernama apa?",
    options: ["Candi Prambanan", "Candi Borobudur", "Candi Mendut", "Candi Sewu"],
    answer: 1,
    explanation:
      "Candi Borobudur dibangun sekitar abad ke-8 hingga ke-9 pada masa Wangsa Syailendra dan merupakan candi Buddha terbesar di dunia.",
  },
  {
    text: "Planet manakah yang dikenal sebagai Planet Merah?",
    options: ["Venus", "Jupiter", "Mars"],
    answer: 2,
    explanation: "Mars tampak merah karena permukaannya kaya akan besi oksida, atau karat.",
  },
  {
    text: "Hewan darat terbesar di dunia adalah?",
    options: ["Gajah Afrika", "Badak", "Jerapah", "Kuda Nil"],
    answer: 0,
    explanation: "Gajah Afrika dapat mencapai berat lebih dari enam ton, sehingga menjadi hewan darat terbesar.",
  },
];
